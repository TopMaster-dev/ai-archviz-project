import { describe, it, expect } from 'vitest';
import { sanitizeUploadFileName, buildStoragePath, validateUpload, MAX_BYTES } from './uploads.js';

// File は .name / .size のみ参照されるため、最小のダミーで十分（環境非依存）。
const fakeFile = (name: string, size: number): File => ({ name, size }) as unknown as File;

describe('sanitizeUploadFileName', () => {
  it('keeps safe names as-is', () => {
    expect(sanitizeUploadFileName('chair.glb')).toBe('chair.glb');
    expect(sanitizeUploadFileName('my-model_01.gltf')).toBe('my-model_01.gltf');
  });

  it('replaces spaces and non-ASCII with underscores and collapses runs', () => {
    expect(sanitizeUploadFileName('my chair.glb')).toBe('my_chair.glb');
    expect(sanitizeUploadFileName('a   b.png')).toBe('a_b.png');
  });

  it('preserves the extension even when the base is fully non-ASCII', () => {
    expect(sanitizeUploadFileName('椅子モデル.glb')).toBe('file.glb');
    expect(sanitizeUploadFileName('木目テクスチャ.png')).toBe('file.png');
  });

  it('strips leading dots/underscores and never returns empty', () => {
    expect(sanitizeUploadFileName('   .glb')).toBe('glb');
    expect(sanitizeUploadFileName('')).toBe('file');
    expect(sanitizeUploadFileName('***')).toBe('file');
  });
});

describe('buildStoragePath', () => {
  it('prefixes with the user id folder (RLS depends on this)', () => {
    expect(buildStoragePath('user-123', 'model', 'chair.glb', 1700000000000)).toBe(
      'user-123/model/1700000000000-chair.glb',
    );
  });

  it('sanitizes the filename segment', () => {
    expect(buildStoragePath('u', 'texture', 'wood floor.png', 42)).toBe('u/texture/42-wood_floor.png');
  });
});

describe('validateUpload', () => {
  it('accepts allowed extensions within size', () => {
    expect(validateUpload(fakeFile('chair.glb', 1000), 'model')).toBeNull();
    expect(validateUpload(fakeFile('SCENE.GLTF', 1000), 'model')).toBeNull();
    expect(validateUpload(fakeFile('wood.png', 1000), 'texture')).toBeNull();
    expect(validateUpload(fakeFile('wood.JPG', 1000), 'texture')).toBeNull();
  });

  it('rejects wrong extension for the kind', () => {
    expect(validateUpload(fakeFile('chair.obj', 1000), 'model')).toMatch(/対応していない/);
    expect(validateUpload(fakeFile('wood.glb', 1000), 'texture')).toMatch(/対応していない/);
    expect(validateUpload(fakeFile('noext', 1000), 'model')).toMatch(/対応していない/);
  });

  it('rejects files over the size limit', () => {
    expect(validateUpload(fakeFile('big.glb', MAX_BYTES.model + 1), 'model')).toMatch(/大きすぎます/);
    expect(validateUpload(fakeFile('big.png', MAX_BYTES.texture + 1), 'texture')).toMatch(/大きすぎます/);
  });
});
