import { describe, it, expect } from 'vitest';
import {
  deriveUploadName,
  uploadToFurnitureItem,
  uploadToProduct,
  isUserUploadProduct,
  normalizeTextureCategory,
  textureCategoryLabel,
  TEXTURE_CATEGORY_OPTIONS,
  USER_UPLOAD_BRAND,
  UPLOAD_FURNITURE_TYPE,
} from './uploadsCatalog.js';
import type { UserUpload } from './db/uploads.js';

const baseUpload = (over: Partial<UserUpload> = {}): UserUpload => ({
  id: 'u1',
  kind: 'model',
  storageUrl: 'https://x.supabase.co/storage/v1/object/public/user-uploads/uid/model/1-chair.glb',
  publicId: 'uid/model/1-chair.glb',
  originalName: 'chair.glb',
  bytes: 1234,
  metadata: {},
  createdAt: '2026-06-10T00:00:00Z',
  ...over,
});

describe('deriveUploadName', () => {
  it('strips the extension and trims', () => {
    expect(deriveUploadName('my chair.glb')).toBe('my chair');
    expect(deriveUploadName('wood.floor.png')).toBe('wood.floor');
  });
  it('falls back for empty/null', () => {
    expect(deriveUploadName(null)).toBe('アップロード');
    expect(deriveUploadName('', 'テクスチャ')).toBe('テクスチャ');
    expect(deriveUploadName('.glb')).toBe('アップロード');
  });
});

describe('uploadToFurnitureItem', () => {
  it('maps a model upload with sensible defaults', () => {
    const item = uploadToFurnitureItem(baseUpload());
    expect(item.id).toBe('upload-u1');
    expect(item.type).toBe(UPLOAD_FURNITURE_TYPE);
    expect(item.name).toBe('chair');
    expect(item.url).toContain('1-chair.glb');
    expect(item.defaultScale).toBe(1);
    // 暫定 1m 角は付けない（260625）。未計測は undefined → ensureUploadFootprint が実測して埋める。
    expect(item.footprint2d).toBeUndefined();
  });

  it('honors footprint/scale from metadata when present', () => {
    const item = uploadToFurnitureItem(
      baseUpload({ metadata: { footprint2d: { widthMm: 600, depthMm: 450 }, defaultScale: 2 } }),
    );
    expect(item.footprint2d).toEqual({ widthMm: 600, depthMm: 450 });
    expect(item.defaultScale).toBe(2);
  });

  it('ignores non-finite metadata values', () => {
    const item = uploadToFurnitureItem(
      baseUpload({ metadata: { footprint2d: { widthMm: 'oops', depthMm: NaN }, defaultScale: null } }),
    );
    expect(item.footprint2d).toBeUndefined();
    expect(item.defaultScale).toBe(1);
  });
});

describe('uploadToProduct', () => {
  it('unassigned texture → 共通 (crossCategory) so it shows in every category', () => {
    const p = uploadToProduct(baseUpload({ kind: 'texture', originalName: 'oak.png' }));
    expect(p.id).toBe('upload-tex-u1');
    expect(p.name).toBe('oak');
    expect(p.brand).toBe(USER_UPLOAD_BRAND);
    expect(p.crossCategory).toBe(true); // 共通: 全カテゴリに表示
    expect(p.textureUrl).toContain('1-chair.glb'); // storageUrl passthrough
    expect(isUserUploadProduct(p)).toBe(true);
  });

  it('assigned Wall/Floor/Ceiling → that category only (crossCategory false)', () => {
    const floor = uploadToProduct(baseUpload({ kind: 'texture', metadata: { category: 'Floor' } }));
    expect(floor.category).toBe('Floor');
    expect(floor.crossCategory).toBe(false);
    const ceil = uploadToProduct(baseUpload({ kind: 'texture', metadata: { category: 'Ceiling' } }));
    expect(ceil.category).toBe('Ceiling');
    expect(ceil.crossCategory).toBe(false);
  });

  it('invalid / non-texture category → 共通 (crossCategory true)', () => {
    // Furniture/Window はテクスチャ割当対象外 → 共通扱い
    expect(uploadToProduct(baseUpload({ kind: 'texture', metadata: { category: 'Furniture' } })).crossCategory).toBe(true);
    expect(uploadToProduct(baseUpload({ kind: 'texture', metadata: { category: 'Bogus' } })).crossCategory).toBe(true);
  });
});

describe('texture category helpers', () => {
  it('normalizeTextureCategory accepts only Wall/Floor/Ceiling, else null', () => {
    expect(normalizeTextureCategory('Wall')).toBe('Wall');
    expect(normalizeTextureCategory('Floor')).toBe('Floor');
    expect(normalizeTextureCategory('Ceiling')).toBe('Ceiling');
    expect(normalizeTextureCategory('Furniture')).toBeNull();
    expect(normalizeTextureCategory(undefined)).toBeNull();
  });
  it('labels and options cover 共通 + the three categories', () => {
    expect(textureCategoryLabel(null)).toBe('共通');
    expect(textureCategoryLabel('Wall')).toBe('壁');
    expect(textureCategoryLabel('Floor')).toBe('床');
    expect(textureCategoryLabel('Ceiling')).toBe('天井');
    expect(TEXTURE_CATEGORY_OPTIONS.map((o) => o.value)).toEqual([null, 'Wall', 'Floor', 'Ceiling']);
  });
});

describe('isUserUploadProduct', () => {
  it('detects by brand', () => {
    expect(isUserUploadProduct({ brand: USER_UPLOAD_BRAND })).toBe(true);
    expect(isUserUploadProduct({ brand: 'Daiken' })).toBe(false);
  });
});
