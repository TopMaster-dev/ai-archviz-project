import { describe, it, expect } from 'vitest';
import { getThumbnailImageUrlFromGlbUrl, getThumbnailPublicIdFromGlbUrl, sanitizeThumbnailPublicId } from './furnitureThumbnailUrl.js';
import { CLOUDINARY_THUMBNAIL_FOLDER, CLOUDINARY_THUMBNAIL_CACHE_BUST } from '../constants/cloudinaryThumbnails.js';

const CB = CLOUDINARY_THUMBNAIL_CACHE_BUST;

describe('furnitureThumbnailUrl（統一フォルダ＋キャッシュバスト・260726）', () => {
  it('配信URLは統一フォルダ＋末尾キャッシュバスト＋.png', () => {
    const glb = 'https://res.cloudinary.com/demo/raw/upload/v1/3d_assets/chair.glb';
    const url = getThumbnailImageUrlFromGlbUrl(glb);
    expect(url).toContain(`/${CLOUDINARY_THUMBNAIL_FOLDER}/`);
    expect(url).toContain('/image/upload/'); // raw→image
    expect(url.endsWith(`chair__${CB}.png`)).toBe(true);
    expect(url).not.toContain('_v2');
    expect(url).not.toContain('_v3');
  });

  it('public_id は folder 除き・拡張子なし・キャッシュバスト付き', () => {
    const glb = 'https://res.cloudinary.com/demo/raw/upload/v1/3d_assets/chair.glb';
    expect(getThumbnailPublicIdFromGlbUrl(glb)).toBe(`chair__${CB}`);
  });

  it('配信URLの末尾と public_id（＋.png）が一致する（保存と配信の整合）', () => {
    const glb = 'https://res.cloudinary.com/demo/raw/upload/v1/3d_assets/sofas/big.glb';
    const publicId = getThumbnailPublicIdFromGlbUrl(glb); // sofas/big__CB
    const url = getThumbnailImageUrlFromGlbUrl(glb);
    expect(url.endsWith(`/${CLOUDINARY_THUMBNAIL_FOLDER}/${publicId}.png`)).toBe(true);
    // upload 側 sanitize を通しても壊れない
    expect(sanitizeThumbnailPublicId(publicId)).toBe(publicId);
  });

  it('materials 由来（.png/.jpg）も配信URLと public_id が対称（拡張子剥がし・260726 敵対レビュー）', () => {
    for (const src of ['materials/tile.png', 'materials/wood.jpg', 'materials/x.webp']) {
      const glb = `https://res.cloudinary.com/demo/image/upload/v1/${src}`;
      const publicId = getThumbnailPublicIdFromGlbUrl(glb);
      const url = getThumbnailImageUrlFromGlbUrl(glb);
      expect(url).toContain(`/${CLOUDINARY_THUMBNAIL_FOLDER}/`);
      // 配信URLの末尾は必ず <public_id>.png（保存と配信が一致＝404にならない）。
      expect(url.endsWith(`/${CLOUDINARY_THUMBNAIL_FOLDER}/${publicId}.png`)).toBe(true);
    }
  });

  it('ドット付きリーフ名は末尾拡張子のみ剥がす', () => {
    const glb = 'https://res.cloudinary.com/demo/raw/upload/v1/3d_assets/chair.v2.glb';
    expect(getThumbnailPublicIdFromGlbUrl(glb)).toBe(`chair.v2__${CB}`);
  });
});
