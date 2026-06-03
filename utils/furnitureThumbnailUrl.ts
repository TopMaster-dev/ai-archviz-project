import { CLOUDINARY_THUMBNAIL_FOLDER } from '../constants/cloudinaryThumbnails.js';

/**
 * GLB の secure_url から、ブラウザが取得するサムネイル PNG の URL を組み立てる。
 * `/api/thumbnails` で保存するパスと論理的に一致させる（3d_assets / materials → thumbnails）。
 */
export function getThumbnailImageUrlFromGlbUrl(glbUrl: string): string {
  const decoded = glbUrl.split('?')[0].split('#')[0];
  return decoded
    .replace('/3d_assets/', `/${CLOUDINARY_THUMBNAIL_FOLDER}/`)
    .replace('/materials/', `/${CLOUDINARY_THUMBNAIL_FOLDER}/`)
    .replace(/\.glb$/i, '.png')
    .replace(/\.gltf$/i, '.png')
    .replace('/raw/upload/', '/image/upload/');
}

/**
 * GLB URL に対応する Cloudinary `public_id`（folder 除く、拡張子なし）。
 * `folder: CLOUDINARY_THUMBNAIL_FOLDER` と組み合わせて upload する。
 */
export function getThumbnailPublicIdFromGlbUrl(glbUrl: string): string {
  const decoded = decodeURIComponent(glbUrl.split('?')[0].split('#')[0]);
  const lower = decoded.toLowerCase();
  const idx3d = lower.indexOf('/3d_assets/');
  const idxMat = lower.indexOf('/materials/');
  let start = -1;
  if (idx3d >= 0 && (idxMat < 0 || idx3d <= idxMat)) {
    start = idx3d + '/3d_assets/'.length;
  } else if (idxMat >= 0) {
    start = idxMat + '/materials/'.length;
  }
  if (start >= 0) {
    const rest = decoded.slice(start);
    return rest.replace(/\.(glb|gltf)$/i, '');
  }
  const last = decoded.split('/').pop() ?? 'default';
  return last.replace(/\.(glb|gltf)$/i, '') || 'default';
}

/**
 * POST /api/thumbnails の fileName（public_id）を検証・正規化。失敗時は null。
 */
export function sanitizeThumbnailPublicId(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const raw = decodeURIComponent(input.trim().split('?')[0].split('#')[0]);
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!stripped) return null;
  if (stripped.includes('..')) return null;
  const segments = stripped.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return null;
  }
  return segments.join('/');
}
