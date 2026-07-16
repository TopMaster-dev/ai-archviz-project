// 大きすぎるテクスチャ画像を自動的に縮小して File を返す（260716 クライアント要望）。
// 長辺を maxSide(既定2048px)以下にし、WebP(透過を保持)で再エンコードする。3D空間ではタイル状に敷き詰めて
// 表示されるため 2K を超える解像度は見た目にほぼ寄与せず容量を圧迫するだけ、という前提。
// 縮小/再エンコードで実際に小さくなったときだけ採用し、非対応形式・失敗時は元の File をそのまま返す（フェイルセーフ）。
// ブラウザ専用（canvas を使用）。非ブラウザ環境では原本を返す。

export const TEXTURE_MAX_SIDE = 2048;
export const TEXTURE_QUALITY = 0.85;

export interface DownsizeResult {
  file: File;
  /** 縮小/再エンコードを実際に採用したか。 */
  resized: boolean;
  originalBytes: number;
  newBytes: number;
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/**
 * テクスチャ画像を縮小した File を返す。透過を失う JPEG は使わず WebP のみ採用（透過テクスチャの黒背景化を防ぐ）。
 */
export async function downsizeImageFile(
  file: File,
  maxSide = TEXTURE_MAX_SIDE,
  quality = TEXTURE_QUALITY,
): Promise<DownsizeResult> {
  const originalBytes = file.size;
  const asIs: DownsizeResult = { file, resized: false, originalBytes, newBytes: originalBytes };
  const type = (file.type || '').toLowerCase();
  // 画像以外・ベクタ(SVG)・アニメGIF は対象外（再エンコードで壊れる/意味がないため原本のまま）。
  if (!type.startsWith('image/') || type === 'image/svg+xml' || type === 'image/gif') return asIs;
  if (typeof document === 'undefined') return asIs;
  try {
    const img = await loadImageFromBlob(file);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return asIs;
    const longSide = Math.max(w, h);
    const scale = longSide > maxSide ? maxSide / longSide : 1;
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx) return asIs;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, tw, th);
    // WebP(透過保持)で再エンコード。canvas が WebP 非対応だと PNG が返るため type を検査し、非WebPなら採用しない。
    const blob = await canvasToBlob(canvas, 'image/webp', quality);
    if (!blob || blob.type !== 'image/webp' || blob.size >= originalBytes) return asIs;
    const base = file.name.replace(/\.[^./\\]+$/, '') || 'texture';
    const newFile = new File([blob], `${base}.webp`, { type: 'image/webp' });
    return { file: newFile, resized: true, originalBytes, newBytes: newFile.size };
  } catch {
    return asIs;
  }
}
