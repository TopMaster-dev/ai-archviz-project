/**
 * 送信ペイロード削減のための data URL 圧縮（260718・エリア編集「差し替え」経路の Vercel body 上限対策）。
 *
 * 背景: エリア編集の差し替えは base 画像とアップロードした参照画像を1つの JSON body で /api/ai-edit に送る。
 * 既存の downscaleDataUrlIfNeeded は「寸法」だけを 2048px に丸める（PNG はロスレス再エンコードなので実バイトは減らない）。
 * そのため 2MB 級の参照画像や大きな base では body が Vercel のサーバレス関数上限(~4.5MB)を超え、原因不明の
 * 「編集に失敗しました」になる。ここでは「送信サイズ（≈ data URL の文字数＝base64 バイト）」を予算内へ収める。
 *
 * 方針（PNG も許可する）:
 *  - 予算内ならそのまま返す（＝小さい PNG は PNG のまま・透過も維持）。
 *  - 予算超過のときだけ、寸法を段階的に縮小しつつ JPEG 品質を下げて予算に収める（JPEG は透過不可なので白で平坦化）。
 *    参照画像は「見た目の手がかり」なので JPEG 化・軽い品質低下は許容範囲。
 *  - どうしても収まらない場合でも、到達できた最小サイズを返す（少なくとも縮む）。DOM/canvas が使えない・失敗時は原本を返す。
 */

/** data URL の送信サイズの概算（≈ 文字数＝JSON body に載る実バイトの目安）。 */
export function dataUrlTransmitBytes(dataUrl: string): number {
  return dataUrl ? dataUrl.length : 0;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export interface CompressBudgetOptions {
  /** 送信サイズの上限（≈ 文字数）。これ以下なら無変換で返す。 */
  maxBytes?: number;
  /** 圧縮に入るときの最大長辺（既定 2048）。 */
  maxSide?: number;
  /** これ以上は縮めない下限長辺（既定 768）。 */
  minSide?: number;
}

export async function compressDataUrlToBudget(
  dataUrl: string,
  opts?: CompressBudgetOptions
): Promise<string> {
  const maxBytes = opts?.maxBytes ?? 1_300_000;
  const startSide = opts?.maxSide ?? 2048;
  const minSide = opts?.minSide ?? 768;
  if (!dataUrl) return dataUrl;
  // 予算内はそのまま（PNG/透過を維持）。
  if (dataUrlTransmitBytes(dataUrl) <= maxBytes) return dataUrl;
  try {
    const img = await loadImage(dataUrl);
    if (!img || !img.naturalWidth || !img.naturalHeight) return dataUrl;
    const qualities = [0.85, 0.75, 0.65, 0.55, 0.45];
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    // 透過を持ちうる形式（PNG/WebP/GIF）は、まず縮小した「PNG（透過維持）」で予算に収まるか試し、収まればそのまま返す
    // （＝透過の参照画像を白箱に潰さない）。PNGで収まらない場合のみ JPEG（白で平坦化）へフォールバックする（260718 監査V3）。
    const mayHaveAlpha = /^data:image\/(png|webp|gif)/i.test(dataUrl);
    let best = dataUrl;
    let bestBytes = dataUrlTransmitBytes(dataUrl);
    // 上端は「元の長辺」と startSide の小さい方（＝拡大はしない）。以降 0.8 倍ずつ縮めて下限まで試す。
    for (let side = Math.min(startSide, longest); side >= minSide; side = Math.round(side * 0.8)) {
      const scale = Math.min(1, side / longest);
      const cw = Math.max(1, Math.round(img.naturalWidth * scale));
      const ch = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d');
      if (!ctx) return best;
      // 透過維持の PNG を先に試す（透過のまま縮小して予算に収まるなら透過を保つ）。
      if (mayHaveAlpha) {
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        const pngOut = c.toDataURL('image/png');
        const pb = dataUrlTransmitBytes(pngOut);
        if (pb < bestBytes) {
          best = pngOut;
          bestBytes = pb;
        }
        if (pb <= maxBytes) return pngOut;
      }
      // JPEG は透過を持てないため、白で平坦化してから描画（写真PNGや大きな透過PNGはこちらで確実に予算へ収める）。
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      for (const q of qualities) {
        const out = c.toDataURL('image/jpeg', q);
        const b = dataUrlTransmitBytes(out);
        if (b < bestBytes) {
          best = out;
          bestBytes = b;
        }
        if (b <= maxBytes) return out;
      }
    }
    return best;
  } catch {
    return dataUrl;
  }
}
