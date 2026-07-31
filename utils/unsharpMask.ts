/**
 * アンシャープマスク（決定論の鮮鋭化・260801 クライアント指摘への対応）。
 *
 * 【なぜ必要か】
 * 「高解像度（AIなし）」は、元画像（長辺2688px前後）を印刷サイズ（A3 300dpi＝長辺4961px）へ
 * 補間で拡大するだけなので、画素は増えても輪郭は甘くなる。
 * クライアントから「ただ引き伸ばしただけのボヤけた画像では実務で使えない」というご指摘があり、
 * これは正しい。補間だけでは情報が増えないため、拡大後の甘さは必ず出る。
 *
 * ただし「AIに描き直させる」以外にも、輪郭のコントラストを回復させる手段はある。
 * それがアンシャープマスクで、写真の現像やスキャン画像の仕上げで昔から使われている定番処理。
 *  - 決定論なので、同じ入力からは必ず同じ結果が出る（生成AIのような揺れが無い）
 *  - 元の画素から計算するだけなので、木目や模様といった「元画像に無いもの」は絶対に生まれない
 *  - APIを呼ばないので費用も待ち時間も発生しない
 * つまり、内容を1ピクセルも変えないという保証を守ったまま、見た目の甘さだけを改善できる。
 *
 * 【原理】ぼかした画像との差分＝輪郭成分。それを元画像へ足し戻すと輪郭が締まる。
 *   出力 = 元 + amount × (元 − ぼかし)
 * ぼかしには「箱ぼかしを3回」を使う。ガウスぼかしの良い近似で、かつ半径によらず一定時間で動く
 * （印刷サイズは1,300万画素を超えるため、素直な畳み込みでは実用的な速度にならない）。
 */

export interface UnsharpOptions {
  /** ぼかし半径（px）。拡大率に比例させる。大きいほど太い輪郭が持ち上がる。 */
  radius?: number;
  /** 強さ。1.0 で「差分をそのまま加算」。上げすぎると輪郭に白フチ（ハロー）が出る。 */
  amount?: number;
  /**
   * この差分未満は輪郭とみなさず素通しする（0-255）。
   * 平坦な面のノイズやJPEGのブロックノイズを持ち上げないための安全弁。
   */
  threshold?: number;
}

const DEFAULTS: Required<UnsharpOptions> = { radius: 1.6, amount: 0.7, threshold: 3 };

/** 水平方向の箱ぼかし（1行ずつ移動和で処理するので半径によらず一定時間）。 */
function boxBlurH(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number): void {
  const span = r + r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      // 左端は端の画素を繰り返して埋める（画面端が暗くならないように）。
      for (let i = -r; i <= r; i++) {
        const x = i < 0 ? 0 : i >= w ? w - 1 : i;
        sum += src[row + x * 4 + c];
      }
      for (let x = 0; x < w; x++) {
        dst[row + x * 4 + c] = sum / span;
        const outX = x - r;
        const inX = x + r + 1;
        sum -= src[row + (outX < 0 ? 0 : outX) * 4 + c];
        sum += src[row + (inX >= w ? w - 1 : inX) * 4 + c];
      }
    }
  }
}

/** 垂直方向の箱ぼかし。 */
function boxBlurV(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number): void {
  const span = r + r + 1;
  const stride = w * 4;
  for (let x = 0; x < w; x++) {
    const col = x * 4;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const y = i < 0 ? 0 : i >= h ? h - 1 : i;
        sum += src[y * stride + col + c];
      }
      for (let y = 0; y < h; y++) {
        dst[y * stride + col + c] = sum / span;
        const outY = y - r;
        const inY = y + r + 1;
        sum -= src[(outY < 0 ? 0 : outY) * stride + col + c];
        sum += src[(inY >= h ? h - 1 : inY) * stride + col + c];
      }
    }
  }
}

/**
 * ImageData をその場で鮮鋭化する（テストしやすいよう画素処理だけを切り出した本体）。
 * アルファは触らない（透過を壊さない）。
 */
export function unsharpMaskImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts: UnsharpOptions = {},
): void {
  const { radius, amount, threshold } = { ...DEFAULTS, ...opts };
  const r = Math.max(1, Math.round(radius));
  if (amount <= 0 || width < 3 || height < 3) return;

  const orig = new Uint8ClampedArray(data);
  const tmp = new Uint8ClampedArray(data.length);
  const blur = new Uint8ClampedArray(data);
  // 箱ぼかし3回でガウスぼかしを近似する。
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(blur, tmp, width, height, r);
    boxBlurV(tmp, blur, width, height, r);
  }

  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const o = orig[i + c];
      const diff = o - blur[i + c];
      // 平坦な面の微小な差分は持ち上げない（ノイズ増幅の防止）。
      if (diff > -threshold && diff < threshold) continue;
      data[i + c] = o + amount * diff;
    }
  }
}

/**
 * 拡大率から鮮鋭化の強さを決める。
 * 等倍なら何もしない（拡大していない画像を勝手にシャープにしない）。
 * 拡大するほど甘くなるので、半径と強さをわずかに上げる。上限を設けてハローを防ぐ。
 */
export function unsharpParamsForUpscale(factor: number): UnsharpOptions | null {
  if (!Number.isFinite(factor) || factor <= 1.02) return null;
  const f = Math.min(factor, 3);
  return {
    radius: Math.min(2.4, 0.9 * f),
    amount: Math.min(0.85, 0.35 * f),
    threshold: 3,
  };
}

/** data URL を鮮鋭化して data URL で返す。失敗時は元をそのまま返す（書き出しを止めない）。 */
export function sharpenDataUrl(dataUrl: string, opts: UnsharpOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    if (!dataUrl) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          resolve(dataUrl);
          return;
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, w, h);
        unsharpMaskImageData(id.data, w, h, opts);
        ctx.putImageData(id, 0, 0);
        // 書き出しは PNG（可逆）。鮮鋭化した輪郭を JPEG で再度潰さない。
        resolve(c.toDataURL('image/png'));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
