import { describe, it, expect } from 'vitest';
import { triangulatePolygon, type Pt } from './polygonTriangulate.js';

/**
 * 部屋（L字などの凹多角形）を凸な三角形へ分ける。
 * 面の重なり計算は凸どうしの交差で組み立てているため、ここが崩れると
 * 「部屋の内側だけ」を正しく切り出せず、見積の面積が狂う。
 */

const area = (poly: readonly Pt[]) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
};
const totalArea = (tris: Pt[][]) => tris.reduce((s, t) => s + area(t), 0);

const RECT: Pt[] = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 5000 }, { x: 0, y: 5000 }];
// L字（凹）: 8m×6m から右下 4m×3m を欠く
const LSHAPE: Pt[] = [
  { x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 3000 },
  { x: 4000, y: 3000 }, { x: 4000, y: 6000 }, { x: 0, y: 6000 },
];

describe('三角形分割', () => {
  it('四角形は2枚', () => {
    const tris = triangulatePolygon(RECT);
    expect(tris).toHaveLength(2);
    expect(totalArea(tris)).toBeCloseTo(area(RECT), 6);
  });

  it('L字（凹）でも面積が一致する', () => {
    const tris = triangulatePolygon(LSHAPE);
    expect(tris.length).toBe(LSHAPE.length - 2);
    expect(totalArea(tris)).toBeCloseTo(area(LSHAPE), 6);
  });

  it('時計回りで与えても同じ面積', () => {
    expect(totalArea(triangulatePolygon([...LSHAPE].reverse()))).toBeCloseTo(area(LSHAPE), 6);
  });

  it('分割後の三角形はすべて反時計回り（内側判定の向きが揃う）', () => {
    for (const t of triangulatePolygon(LSHAPE)) {
      const cross = (t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[1].y - t[0].y) * (t[2].x - t[0].x);
      expect(cross).toBeGreaterThan(0);
    }
  });

  it('頂点不足・面積0・壊れた入力は空配列（落ちない）', () => {
    expect(triangulatePolygon([])).toEqual([]);
    expect(triangulatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
    expect(triangulatePolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }])).toEqual([]); // 一直線
    expect(triangulatePolygon([{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toEqual([]);
  });

  it('複雑な凹多角形でも面積が保存される', () => {
    const zig: Pt[] = [
      { x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 1000 }, { x: 1000, y: 1000 },
      { x: 1000, y: 2000 }, { x: 4000, y: 2000 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 },
    ];
    expect(totalArea(triangulatePolygon(zig))).toBeCloseTo(area(zig), 6);
  });
});
