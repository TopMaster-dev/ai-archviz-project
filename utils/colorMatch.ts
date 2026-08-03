/**
 * 参照画像（プレビュー）の全体的な色味へ、対象画像（AI精細化の出力）を合わせる（260725・クライアント要望）。
 *
 * AI精細化は構図・形状は保つが、全体の色味（ホワイトバランス＝赤み/暖色）がズレることがある。
 * 両画像は構図が一致しているので、「チャンネル別の平均色の比（ゲイン）」を対象画像へ掛けることで、
 * 低周波の色だけをプレビューへ寄せる。高周波のディテール（AIの精細化）は保たれる。
 *
 * 【260803 クライアント指摘「赤みが再発する」の原因と対策】
 * 処理自体は動いていたが、次の3点で「明るい部屋ほど効かない」状態だった。
 *
 *  ① 白飛びした画素まで平均に含めていた。
 *     大きな窓のある昼のリビングでは、窓の白（＝色が無い）が平均を支配し、
 *     「もう色は合っている」と誤判定してゲインがほぼ1になっていた。
 *     実際、白飛びの無い夜のオフィスでは赤みが出ず、窓の大きい昼のリビングだけで出ていた。
 *  ② ガンマ空間で掛けていた。ホワイトバランス補正は本来リニア光での操作で、
 *     ガンマ空間の乗算は明るい部分の補正が足りなくなる。赤みが天井や窓際に強く残るのはこれ。
 *  ③ 上限で単純に切り捨てていた。暖色を戻すには青を持ち上げる必要があるが、
 *     明るい部分では青が既に上限付近で、持ち上げ分が捨てられていた。
 *
 * 対策として、統計から白飛び・黒つぶれを除外し、リニア光で計算・適用し、
 * 上限付近はソフトに丸める。補正後に残差を検算して、効かなかった場合は記録を残す。
 */

/** 統計に使う画素の明度範囲（sRGB 0-255）。この外＝白飛び/黒つぶれとみなし、色の判断材料にしない。 */
const STAT_MIN = 8;
const STAT_MAX = 243;
/** 統計に使える画素がこの割合未満なら補正しない（判断材料が足りない）。 */
const MIN_SAMPLE_RATIO = 0.05;
/** ゲインの上下限。統計が壊れたときに大きく外さないための安全弁。 */
const GAIN_MIN = 0.8;
const GAIN_MAX = 1.25;
/** 統計をとる縮小サイズ（長辺）。ノイズに強く、かつ十分な画素数を確保できる大きさ。 */
const STAT_LONG_SIDE = 128;
/** これ未満のズレは補正しない（無駄な再エンコードを避ける）。 */
const NEGLIGIBLE = 0.01;

const srgbToLinear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

const linearToSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/**
 * 1.0 を超える分をソフトに丸める（単純な切り捨てだと、明るい部分だけ補正が消える）。
 * 0.85 までは素通しし、そこから上を 1.0 へ漸近させる。
 */
function softClipLinear(v: number): number {
  const knee = 0.85;
  if (v <= knee) return v;
  const over = v - knee;
  return knee + (1 - knee) * (1 - Math.exp(-over / (1 - knee)));
}

/** 2枚の同構図画像から、統計に使える画素だけでチャンネル別のリニア平均を求める。 */
function linearMeansExcludingClipped(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
): { a: [number, number, number]; b: [number, number, number]; ratio: number } | null {
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let br = 0;
  let bg = 0;
  let bb = 0;
  let n = 0;
  const total = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    // 両方の画像で「白飛びでも黒つぶれでもない」画素だけを数える。
    const okA = a[i] >= STAT_MIN && a[i] <= STAT_MAX && a[i + 1] >= STAT_MIN && a[i + 1] <= STAT_MAX && a[i + 2] >= STAT_MIN && a[i + 2] <= STAT_MAX;
    if (!okA) continue;
    const okB = b[i] >= STAT_MIN && b[i] <= STAT_MAX && b[i + 1] >= STAT_MIN && b[i + 1] <= STAT_MAX && b[i + 2] >= STAT_MIN && b[i + 2] <= STAT_MAX;
    if (!okB) continue;
    ar += srgbToLinear(a[i]);
    ag += srgbToLinear(a[i + 1]);
    ab += srgbToLinear(a[i + 2]);
    br += srgbToLinear(b[i]);
    bg += srgbToLinear(b[i + 1]);
    bb += srgbToLinear(b[i + 2]);
    n++;
  }
  if (!n || n / total < MIN_SAMPLE_RATIO) return null;
  return { a: [ar / n, ag / n, ab / n], b: [br / n, bg / n, bb / n], ratio: n / total };
}

/**
 * ゲインを求める（純関数・テスト用に公開）。
 * @param image 対象画像の縮小画素（RGBA）
 * @param reference 参照画像の縮小画素（RGBA）
 * @returns 補正が必要なら [R,G,B] のゲイン、不要・判断不能なら null
 */
export function computeChannelGains(
  image: Uint8ClampedArray,
  reference: Uint8ClampedArray,
): [number, number, number] | null {
  const m = linearMeansExcludingClipped(image, reference);
  if (!m) return null;
  const clamp = (x: number) => Math.max(GAIN_MIN, Math.min(GAIN_MAX, x));
  const g: [number, number, number] = [
    clamp(m.a[0] > 1e-6 ? m.b[0] / m.a[0] : 1),
    clamp(m.a[1] > 1e-6 ? m.b[1] / m.a[1] : 1),
    clamp(m.a[2] > 1e-6 ? m.b[2] / m.a[2] : 1),
  ];
  if (Math.abs(g[0] - 1) < NEGLIGIBLE && Math.abs(g[1] - 1) < NEGLIGIBLE && Math.abs(g[2] - 1) < NEGLIGIBLE) {
    return null;
  }
  return g;
}

/** ゲインをリニア光で適用する（純関数・テスト用に公開）。アルファは触らない。 */
export function applyGainsLinear(data: Uint8ClampedArray, gains: [number, number, number]): void {
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const lin = srgbToLinear(data[i + c]) * gains[c];
      data[i + c] = linearToSrgb(softClipLinear(lin));
    }
  }
}

export function matchOverallColorToReference(
  imageDataUrl: string,
  referenceDataUrl: string,
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    const ref = new Image();

    /** 同じ画素数へ縮小して返す（同構図なので位置が対応する）。 */
    const sampleOf = (im: HTMLImageElement, w: number, h: number): Uint8ClampedArray | null => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };

    const onBoth = () => {
      try {
        if (!img.naturalWidth || !ref.naturalWidth) {
          resolve(imageDataUrl);
          return;
        }
        // 統計は「対象画像の縦横比」で揃える（両者は同構図なので、同じ格子で対応が取れる）。
        const scale = STAT_LONG_SIDE / Math.max(img.naturalWidth, img.naturalHeight);
        const sw = Math.max(1, Math.round(img.naturalWidth * scale));
        const sh = Math.max(1, Math.round(img.naturalHeight * scale));
        const si = sampleOf(img, sw, sh);
        const sr = sampleOf(ref, sw, sh);
        if (!si || !sr) {
          resolve(imageDataUrl);
          return;
        }
        const gains = computeChannelGains(si, sr);
        if (!gains) {
          resolve(imageDataUrl);
          return;
        }

        const W = img.naturalWidth;
        const H = img.naturalHeight;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(imageDataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, W, H);
        applyGainsLinear(id.data, gains);
        ctx.putImageData(id, 0, 0);

        /*
         * 検算: 補正後の残差を測り、まだ大きければ記録を残す。
         * 「処理は走っているのに色が合っていない」状態を、次に再発したとき
         * 原因調査のやり直しから始めなくて済むようにするための保険。
         */
        try {
          const sc = document.createElement('canvas');
          sc.width = sw;
          sc.height = sh;
          const sctx = sc.getContext('2d', { willReadFrequently: true });
          if (sctx) {
            sctx.imageSmoothingEnabled = true;
            sctx.imageSmoothingQuality = 'high';
            sctx.drawImage(c, 0, 0, sw, sh);
            const residual = computeChannelGains(sctx.getImageData(0, 0, sw, sh).data, sr);
            if (residual) {
              const worst = Math.max(...residual.map((g) => Math.abs(g - 1)));
              if (worst > 0.05) {
                console.warn('[colorMatch] 補正後も色ズレが残っています', { gains, residual });
              }
            }
          }
        } catch {
          /* 検算は補助。失敗しても出力には影響させない */
        }

        const out = imageDataUrl.startsWith('data:image/jpeg')
          ? c.toDataURL('image/jpeg', 0.95)
          : c.toDataURL('image/png');
        resolve(out);
      } catch {
        resolve(imageDataUrl);
      }
    };

    let loaded = 0;
    const done = () => {
      loaded++;
      if (loaded === 2) onBoth();
    };
    img.onload = done;
    ref.onload = done;
    img.onerror = () => resolve(imageDataUrl);
    ref.onerror = () => resolve(imageDataUrl);
    img.src = imageDataUrl;
    ref.src = referenceDataUrl;
  });
}
