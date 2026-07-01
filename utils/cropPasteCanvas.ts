import type { CropPx } from './maskCropRemap.js';

/**
 * エリア編集の領域クロップ用 canvas 処理（260702）。fitDataUrl/downscale と同じ安全契約:
 * 失敗時は入力をそのまま返し、編集結果を失わない。純粋な座標計算は maskCropRemap.ts 側。
 */

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

function outMime(dataUrl: string): 'image/jpeg' | 'image/png' {
  return dataUrl.startsWith('data:image/jpeg') || /\.jpe?g/i.test(dataUrl.slice(0, 40))
    ? 'image/jpeg'
    : 'image/png';
}

/** ベース画像を crop 矩形で切り出して data URL を返す（失敗時は元 URL）。 */
export async function cropDataUrl(dataUrl: string, crop: CropPx): Promise<string> {
  try {
    if (crop.sw <= 0 || crop.sh <= 0) return dataUrl;
    const img = await loadImage(dataUrl);
    const c = document.createElement('canvas');
    c.width = crop.sw;
    c.height = crop.sh;
    const ctx = c.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    const mime = outMime(dataUrl);
    return mime === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png');
  } catch {
    return dataUrl;
  }
}

/**
 * 編集済みクロップ（crop.sw×crop.sh 相当）を、ベース（baseW×baseH）の crop 位置へ貼り戻した
 * 全体画像を返す。crop 外は 100% ベースのまま（バイト一致）。失敗時はベースを返す（＝編集なしの安全側）。
 */
export async function pasteCropIntoBase(
  baseDataUrl: string,
  editedCropDataUrl: string,
  crop: CropPx,
  baseW: number,
  baseH: number
): Promise<string> {
  try {
    if (baseW <= 0 || baseH <= 0) return baseDataUrl;
    const [baseImg, cropImg] = await Promise.all([loadImage(baseDataUrl), loadImage(editedCropDataUrl)]);
    const c = document.createElement('canvas');
    c.width = baseW;
    c.height = baseH;
    const ctx = c.getContext('2d');
    if (!ctx) return baseDataUrl;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(baseImg, 0, 0, baseW, baseH);
    ctx.drawImage(
      cropImg,
      0,
      0,
      cropImg.naturalWidth || crop.sw,
      cropImg.naturalHeight || crop.sh,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh
    );
    const mime = outMime(baseDataUrl);
    return mime === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png');
  } catch {
    return baseDataUrl;
  }
}
