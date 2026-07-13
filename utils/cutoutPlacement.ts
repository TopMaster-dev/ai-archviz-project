import type { BBox01 } from './maskCropRemap.js';

/**
 * 参照商品画像の切り抜き（cutout）を、囲った範囲（region）へ「決定論で」配置する座標計算（純関数・260712・フェーズ2）。
 * 商品の内部ピクセルはモデルに一切渡さず、この矩形にそのまま貼るので、商品は完全一致（ブランド・比率・形が崩れない）。
 * アスペクト比を保ち、既定は「床置き（floor）」＝範囲の下端に接地。実際の描画は utils/compositeCutout（canvas）。
 */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface CutoutPlacement {
  /** ベース画像上のピクセル座標・寸法。 */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface CutoutPlaceOpts {
  /** 商品幅 ÷ 範囲幅（既定 0.9）。実機テストで調整するツマミ。 */
  fitFrac?: number;
  /** 接地基準（既定 floor＝範囲下端に接地 / center＝中央）。 */
  anchor?: 'floor' | 'center';
  /** 範囲下端からの余白（範囲高さ比・既定 0.02）。 */
  bottomInsetFrac?: number;
  /** 範囲内の水平位置 0..1（既定 0.5＝中央）。 */
  hAlign?: number;
  /** 商品高さの上限（範囲高さ比・既定 1.0＝範囲高さまで）。 */
  maxHeightFrac?: number;
}

/**
 * cutoutW/H: 切り抜き画像の実寸（px）。region: 囲みの外接矩形（正規化 0..1）。baseW/H: ベース画像の実寸（px）。
 * 戻り値はベース画像上の描画矩形（px）。アスペクト比は cutout に一致。範囲外へはみ出さないようクランプ。
 */
export function computeCutoutPlacement(
  cutoutW: number,
  cutoutH: number,
  region: BBox01,
  baseW: number,
  baseH: number,
  opts?: CutoutPlaceOpts,
): CutoutPlacement {
  const regX = region.x * baseW;
  const regY = region.y * baseH;
  const regW = region.w * baseW;
  const regH = region.h * baseH;
  if (regW <= 0 || regH <= 0 || cutoutW <= 0 || cutoutH <= 0 || baseW <= 0 || baseH <= 0) {
    return { dx: Math.max(0, regX), dy: Math.max(0, regY), dw: 0, dh: 0 };
  }

  const fitFrac = opts?.fitFrac ?? 0.9;
  const anchor = opts?.anchor ?? 'floor';
  const bottomInset = opts?.bottomInsetFrac ?? 0.02;
  const hAlign = clamp01(opts?.hAlign ?? 0.5);
  const maxHFrac = opts?.maxHeightFrac ?? 1.0;

  const aspect = cutoutW / cutoutH;
  // 幅は範囲幅の fitFrac、高さはアスペクト比から。高さが上限を超えたら高さ基準に切替。
  // floor 接地では下端に bottomInset ぶんの余白を取るため、その分だけ高さ上限を減らす。こうしないと
  // 「範囲高さいっぱい(maxHFrac=1)＋下余白」で背の高い商品の上端が範囲の外へはみ出し、最終の多角形
  // クリップで頭が切れてしまう（260712 検証で検出）。center 接地は下余白を使わないので減らさない。
  const insetPx = anchor === 'floor' ? regH * bottomInset : 0;
  let dw = regW * fitFrac;
  let dh = dw / aspect;
  const maxH = Math.max(0, regH * maxHFrac - insetPx);
  if (dh > maxH) {
    dh = maxH;
    dw = dh * aspect;
  }

  // 水平: 範囲内で hAlign 配置。
  let dx = regX + (regW - dw) * hAlign;
  // 垂直: floor=範囲下端(−余白)に商品の下端を接地 / center=中央。
  let dy: number;
  if (anchor === 'floor') {
    const bottom = regY + regH - regH * bottomInset;
    dy = bottom - dh;
  } else {
    dy = regY + (regH - dh) / 2;
  }

  // 商品が範囲内に収まるサイズなら、範囲の内側へも収める（上端/下端のはみ出し＝最終クリップでの切れを防ぐ）。
  // 範囲より高い/広い稀ケース（maxHFrac>1 等）は下のベースクランプに委ねる。
  if (dh <= regH) dy = Math.max(regY, Math.min(dy, regY + regH - dh));
  if (dw <= regW) dx = Math.max(regX, Math.min(dx, regX + regW - dw));
  // ベース画像内へクランプ（範囲より商品が大きい稀ケースの安全）。
  dx = Math.max(0, Math.min(dx, baseW - dw));
  dy = Math.max(0, Math.min(dy, baseH - dh));
  return { dx, dy, dw, dh };
}
