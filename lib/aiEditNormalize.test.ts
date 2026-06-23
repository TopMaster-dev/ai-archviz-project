import { describe, it, expect } from 'vitest';
import {
  normalizeObjectReference,
  normalizeAiEditVersion,
  normalizeStoredVersions,
} from './aiEditNormalize.js';

describe('normalizeObjectReference', () => {
  it('rejects non-objects and entries without a string id', () => {
    expect(normalizeObjectReference(null)).toBeNull();
    expect(normalizeObjectReference('x')).toBeNull();
    expect(normalizeObjectReference({ memo: 'no id' })).toBeNull();
  });

  it('normalizes a full reference and aligns placementMemos to placements', () => {
    const n = normalizeObjectReference({
      id: 'a',
      imageDataUrl: 'data:image/png;base64,xxx',
      memo: 'hi',
      placements: [
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 2, y: 2, width: 3, height: 3 },
      ],
      placementMemos: ['first'],
    });
    expect(n).not.toBeNull();
    expect(n!.id).toBe('a');
    expect(n!.placements).toHaveLength(2);
    // memo array is realigned to placement count, padding the missing one with ''
    expect(n!.placementMemos).toEqual(['first', '']);
  });

  it('accepts a singular placement and drops malformed rects', () => {
    const n = normalizeObjectReference({
      id: 'b',
      placement: { x: 0, y: 0, width: 5, height: 5 },
    });
    expect(n!.placements).toHaveLength(1);

    const bad = normalizeObjectReference({
      id: 'c',
      placements: [{ x: 0, y: 0 }, { x: 1, y: 1, width: 1, height: 1 }],
    });
    expect(bad!.placements).toHaveLength(1);
  });

  it('preserves polygon mask points (>=3) and drops degenerate/invalid ones', () => {
    const n = normalizeObjectReference({
      id: 'p',
      placements: [
        // 多角形（3頂点以上）はそのまま保持
        {
          x: 0.1,
          y: 0.1,
          width: 0.4,
          height: 0.3,
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.5, y: 0.2 },
            { x: 0.3, y: 0.4 },
          ],
        },
        // 2頂点・不正頂点は落として矩形のみ残す
        { x: 0, y: 0, width: 1, height: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { x: 0, y: 0, width: 1, height: 1, points: 'oops' },
      ],
    });
    expect(n!.placements).toHaveLength(3);
    expect(n!.placements[0].points).toHaveLength(3);
    expect(n!.placements[1].points).toBeUndefined();
    expect(n!.placements[2].points).toBeUndefined();
  });

  it('treats the literal strings "null"/"undefined"/blank as no image', () => {
    expect(normalizeObjectReference({ id: 'd', imageDataUrl: 'null' })!.imageDataUrl).toBeNull();
    expect(normalizeObjectReference({ id: 'e', imageDataUrl: '   ' })!.imageDataUrl).toBeNull();
  });
});

describe('normalizeAiEditVersion / normalizeStoredVersions', () => {
  const valid = {
    id: 'v1',
    parentId: null,
    createdAt: 1700000000000,
    baseImageDataUrl: 'data:image/png;base64,base',
    outputImageDataUrl: 'data:image/png;base64,out',
    objects: [{ id: 'o1', placement: { x: 0, y: 0, width: 1, height: 1 } }],
  };

  it('accepts a valid version and normalizes its objects', () => {
    const v = normalizeAiEditVersion(valid);
    expect(v).not.toBeNull();
    expect(v!.objects).toHaveLength(1);
    expect(v!.styleMemo).toBe('');
  });

  it('rejects versions missing required fields', () => {
    expect(normalizeAiEditVersion({ ...valid, createdAt: 'nope' })).toBeNull();
    expect(normalizeAiEditVersion({ ...valid, outputImageDataUrl: 123 })).toBeNull();
    expect(normalizeAiEditVersion(null)).toBeNull();
  });

  it('filters a stored array down to valid versions only', () => {
    expect(normalizeStoredVersions([valid, { id: 'broken' }, null])).toHaveLength(1);
    expect(normalizeStoredVersions('not an array')).toEqual([]);
  });
});
