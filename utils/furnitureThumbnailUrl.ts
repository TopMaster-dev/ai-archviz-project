import { CLOUDINARY_THUMBNAIL_FOLDER, CLOUDINARY_THUMBNAIL_CACHE_BUST } from '../constants/cloudinaryThumbnails.js';

/**
 * ソースの拡張子（3D: glb/gltf、建材画像: png/jpg/jpeg/webp）だけを末尾から1つ剥がす（260726）。
 * 配信URL側と public_id 側で「同じ剥がし方」をして左右対称に保つ（materials の .png/.jpg でも 404 にしない）。
 * ドット付きリーフ名（例: chair.v2.glb）は末尾の既知拡張子のみ剥がし、中間ドットは保持する。
 */
function stripThumbnailSourceExt(leafOrPath: string): string {
  return leafOrPath.replace(/\.(glb|gltf|png|jpe?g|webp)$/i, '');
}

/**
 * public_id（拡張子なし・末尾がリーフ）へキャッシュバスト・トークンを付与する（260726・②）。
 * フォルダを増やさず、ファイル名側で世代管理するための仕組み。空トークン時はそのまま返す。
 */
function appendThumbnailCacheBust(publicId: string): string {
  return CLOUDINARY_THUMBNAIL_CACHE_BUST ? `${publicId}__${CLOUDINARY_THUMBNAIL_CACHE_BUST}` : publicId;
}

/**
 * GLB の secure_url から、ブラウザが取得するサムネイル PNG の URL を組み立てる。
 * `/api/thumbnails` で保存するパスと論理的に一致させる（3d_assets / materials → 統一フォルダ）。
 * 260726: フォルダは1つに統一し、キャッシュバストは拡張子直前の `__<token>` で行う（フォルダを増やさない）。
 * ソース拡張子は glb/gltf/png/jpg/webp を剥がして必ず `<leaf>__<token>.png` に正規化（public_id 側と対称）。
 */
export function getThumbnailImageUrlFromGlbUrl(glbUrl: string): string {
  const decoded = glbUrl.split('?')[0].split('#')[0];
  const withFolder = decoded
    .replace('/3d_assets/', `/${CLOUDINARY_THUMBNAIL_FOLDER}/`)
    .replace('/materials/', `/${CLOUDINARY_THUMBNAIL_FOLDER}/`)
    .replace('/raw/upload/', '/image/upload/');
  const noExt = stripThumbnailSourceExt(withFolder); // 末尾のソース拡張子を除去（.png/.jpg 含む）
  const cb = CLOUDINARY_THUMBNAIL_CACHE_BUST ? `__${CLOUDINARY_THUMBNAIL_CACHE_BUST}` : '';
  return `${noExt}${cb}.png`;
}

/**
 * GLB URL に対応する Cloudinary `public_id`（folder 除く、拡張子なし・キャッシュバスト付き）。
 * `folder: CLOUDINARY_THUMBNAIL_FOLDER` と組み合わせて upload する。配信URLと同じ拡張子剥がしで左右対称に保つ。
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
    return appendThumbnailCacheBust(stripThumbnailSourceExt(rest));
  }
  const last = decoded.split('/').pop() ?? 'default';
  return appendThumbnailCacheBust(stripThumbnailSourceExt(last) || 'default');
}

/**
 * 公式カタログ（Cloudinary の 3d_assets / materials 領域）由来の URL か（260726・クライアント要望③）。
 * 一般ユーザーがアップロードした 3D モデルは Supabase 由来（この判定に該当しない）＝サムネイルを Cloudinary へ送らない。
 * これにより「公式＝Cloudinary」「ユーザー＝Supabase」の責務分担を厳守し、両者が混ざらないようにする。
 */
export function isOfficialCatalogModelUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || !url) return false;
  const s = url.split('?')[0].split('#')[0];
  return s.includes('/3d_assets/') || s.includes('/materials/');
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
