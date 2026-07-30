/**
 * 画像の一部を「元の解像度のまま」切り出す（260728 ポップアップ / 260729 プレビュー上クロップの共通処理）。
 *
 * 切り出しは必ず自然解像度で行うこと。画面表示サイズで切ると、縮小表示されている画像では
 * 情報が落ちたまま Vision へ送ることになり、そもそもの目的（見た目で商品を特定する）の精度が落ちる。
 */

/** 画像全体を 0〜1 で表した矩形。 */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 切り出しが小さすぎる（＝誤操作）と見なす画素数。これ未満なら画像全体を対象にする。 */
const MIN_CROP_PX = 8;

/**
 * 元画像の解像度で矩形を切り出して data URL を返す。範囲が極小・未指定なら画像全体を返す。
 *
 * crossOrigin='anonymous' は必須。第三者ドメインの画像をこれ無しで canvas に描くと
 * canvas が汚染され toDataURL が例外になる（＝切り出しが常に失敗する）。
 */
export async function cropToDataUrl(imageUrl: string, rect: NormRect | null): Promise<string> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    img.src = imageUrl;
  });
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const useWhole = !rect || rect.w * nw < MIN_CROP_PX || rect.h * nh < MIN_CROP_PX;
  const sx = useWhole ? 0 : Math.round(rect!.x * nw);
  const sy = useWhole ? 0 : Math.round(rect!.y * nh);
  const sw = useWhole ? nw : Math.max(1, Math.round(rect!.w * nw));
  const sh = useWhole ? nh : Math.max(1, Math.round(rect!.h * nh));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像の切り出しに失敗しました。');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/png');
}

/** 矩形を画像内へ収める。幅・高さは最低 min（0〜1）を保つ。 */
/**
 * クロップ枠の初期値（260731 クライアント要望③）。
 *
 * 以前は画像全体（x:0 y:0 w:1 h:1）から始めていた。全体のままでも検索は走るが、
 * それは「部屋の風景」を照合しに行くのと同じで、個別の商品はまず特定できない。
 * 最初から中央の小さめの枠にしておけば、「ここを絞る道具だ」と説明なしで伝わる。
 *
 * 画像の中央 50%（面積では 1/4）。これ以上小さくすると、対象が枠の外にあるとき
 * 掴んで広げる手数が増える。Google レンズの初期枠もおおむねこの程度。
 */
export const DEFAULT_CROP_RECT: NormRect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

export function clampRect(r: NormRect, min = 0.04): NormRect {
  const w = Math.min(1, Math.max(min, r.w));
  const h = Math.min(1, Math.max(min, r.h));
  return {
    w,
    h,
    x: Math.min(1 - w, Math.max(0, r.x)),
    y: Math.min(1 - h, Math.max(0, r.y)),
  };
}

/** 対角2点から正規化矩形を作る（ドラッグの向きに依存しない）。 */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): NormRect {
  const x0 = Math.min(ax, bx);
  const y0 = Math.min(ay, by);
  return { x: x0, y: y0, w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}
