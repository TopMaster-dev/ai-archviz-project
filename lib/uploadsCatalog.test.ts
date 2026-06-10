import { describe, it, expect } from 'vitest';
import {
  deriveUploadName,
  uploadToFurnitureItem,
  uploadToProduct,
  isUserUploadProduct,
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
    expect(item.footprint2d).toEqual({ widthMm: 1000, depthMm: 1000 });
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
    expect(item.footprint2d).toEqual({ widthMm: 1000, depthMm: 1000 });
    expect(item.defaultScale).toBe(1);
  });
});

describe('uploadToProduct', () => {
  it('maps a texture upload as a user-brand material defaulting to Wall', () => {
    const p = uploadToProduct(baseUpload({ kind: 'texture', originalName: 'oak.png' }));
    expect(p.id).toBe('upload-tex-u1');
    expect(p.name).toBe('oak');
    expect(p.brand).toBe(USER_UPLOAD_BRAND);
    expect(p.category).toBe('Wall');
    expect(p.textureUrl).toContain('1-chair.glb'); // storageUrl passthrough
    expect(isUserUploadProduct(p)).toBe(true);
  });

  it('uses a valid category from metadata and rejects an invalid one', () => {
    expect(uploadToProduct(baseUpload({ metadata: { category: 'Floor' } })).category).toBe('Floor');
    expect(uploadToProduct(baseUpload({ metadata: { category: 'Bogus' } })).category).toBe('Wall');
  });
});

describe('isUserUploadProduct', () => {
  it('detects by brand', () => {
    expect(isUserUploadProduct({ brand: USER_UPLOAD_BRAND })).toBe(true);
    expect(isUserUploadProduct({ brand: 'Daiken' })).toBe(false);
  });
});
