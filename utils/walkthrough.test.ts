import { describe, it, expect } from 'vitest';
import { clampXZToPolygon, pointInPolygonXZ } from './walkthrough.js';

// L字の部屋: 外接矩形は 0..4 四方だが、右上 [2,4]×[2,4] が欠ける（ウォークで通り抜けが起きていた形状）。
const L_ROOM = [
  { x: 0, z: 0 },
  { x: 4, z: 0 },
  { x: 4, z: 2 },
  { x: 2, z: 2 },
  { x: 2, z: 4 },
  { x: 0, z: 4 },
];

describe('pointInPolygonXZ', () => {
  it('L字の欠け（ノッチ）内の点は外側、部屋内の点は内側と判定する', () => {
    expect(pointInPolygonXZ(3, 3, L_ROOM)).toBe(false); // ノッチ（外接矩形内だが部屋外）
    expect(pointInPolygonXZ(1, 1, L_ROOM)).toBe(true); // 部屋内
    expect(pointInPolygonXZ(1, 3, L_ROOM)).toBe(true); // L の縦腕
    expect(pointInPolygonXZ(10, 10, L_ROOM)).toBe(false); // 完全に外
  });
});

describe('clampXZToPolygon', () => {
  it('壁から十分内側の点はそのまま', () => {
    const [x, z] = clampXZToPolygon(1, 1, L_ROOM, 0.12);
    expect(x).toBeCloseTo(1);
    expect(z).toBeCloseTo(1);
  });

  it('外接矩形内でもポリゴン外（ノッチ＝通り抜けていた壁の裏）の点は部屋内へ押し戻す', () => {
    const [x, z] = clampXZToPolygon(3, 3, L_ROOM, 0.12);
    expect(pointInPolygonXZ(x, z, L_ROOM)).toBe(true);
  });

  it('完全に部屋の外側の点も部屋内へ押し戻す', () => {
    const [x, z] = clampXZToPolygon(10, 1, L_ROOM, 0.12);
    expect(pointInPolygonXZ(x, z, L_ROOM)).toBe(true);
    expect(x).toBeLessThanOrEqual(4);
  });

  it('頂点未満（部屋が成立しない）は素通し', () => {
    expect(
      clampXZToPolygon(5, 5, [
        { x: 0, z: 0 },
        { x: 1, z: 1 },
      ], 0.1)
    ).toEqual([5, 5]);
  });
});
