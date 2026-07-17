import { describe, it, expect } from 'vitest';
import {
  beamFootprintCornersMm,
  convexIntersectionAreaMm2,
  beamOverlapDeductionByIdM2
} from './beamOverlap.js';
import type { Beam } from '../lib/project/projectState.js';

const beam = (over: Partial<Beam>): Beam => ({
  id: 'b',
  cx: 0,
  cy: 0,
  lengthMm: 2000,
  angleDeg: 0,
  widthMm: 200,
  dropMm: 0,
  heightMm: 300,
  ...over
});

describe('beamFootprintCornersMm', () => {
  it('角度0の梁は軸整列の矩形', () => {
    const c = beamFootprintCornersMm({ cx: 0, cy: 0, lengthMm: 1000, angleDeg: 0, widthMm: 200 });
    const xs = c.map((p) => p.x).sort((a, b) => a - b);
    const ys = c.map((p) => p.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-500, 6);
    expect(xs[3]).toBeCloseTo(500, 6);
    expect(ys[0]).toBeCloseTo(-100, 6);
    expect(ys[3]).toBeCloseTo(100, 6);
  });
});

describe('convexIntersectionAreaMm2', () => {
  const sq = (x0: number, y0: number, s: number) => [
    { x: x0, y: y0 },
    { x: x0 + s, y: y0 },
    { x: x0 + s, y: y0 + s },
    { x: x0, y: y0 + s }
  ];
  it('重なる正方形は交差面積を返す', () => {
    expect(convexIntersectionAreaMm2(sq(0, 0, 10), sq(5, 5, 10))).toBeCloseTo(25, 6);
  });
  it('離れた矩形は0', () => {
    expect(convexIntersectionAreaMm2(sq(0, 0, 10), sq(20, 20, 10))).toBe(0);
  });
  it('完全内包は小さい方の面積', () => {
    expect(convexIntersectionAreaMm2(sq(0, 0, 10), sq(2, 2, 4))).toBeCloseTo(16, 6);
  });
  it('巻き方向(CW/CCW)に依らず同じ', () => {
    const ccw = sq(0, 0, 10);
    const cw = [...sq(5, 5, 10)].reverse();
    expect(convexIntersectionAreaMm2(ccw, cw)).toBeCloseTo(25, 6);
  });
});

describe('beamOverlapDeductionByIdM2', () => {
  it('天井フラッシュの十字交差: 下面の重なり分を50/50で控除', () => {
    // A(水平)×B(垂直) 各 2000×200、中心原点、交差 200×200=0.04m²。drop0→上面非露出/下面露出→sharedFaces=1。
    const ded = beamOverlapDeductionByIdM2(
      [beam({ id: 'a', angleDeg: 0 }), beam({ id: 'b', angleDeg: 90 })],
      2700
    );
    expect(ded.get('a')).toBeCloseTo(0.02, 6);
    expect(ded.get('b')).toBeCloseTo(0.02, 6);
    // 合計は交差1面分 = 0.04
    expect((ded.get('a') ?? 0) + (ded.get('b') ?? 0)).toBeCloseTo(0.04, 6);
  });

  it('下がり梁の十字交差: 上面+下面の2面分を控除', () => {
    const ded = beamOverlapDeductionByIdM2(
      [
        beam({ id: 'a', angleDeg: 0, dropMm: 200 }),
        beam({ id: 'b', angleDeg: 90, dropMm: 200 })
      ],
      2700
    );
    // 交差0.04 × 2面 = 0.08、50/50 → 各0.04
    expect(ded.get('a')).toBeCloseTo(0.04, 6);
    expect(ded.get('b')).toBeCloseTo(0.04, 6);
  });

  it('鉛直帯が重ならない積み重なりは控除しない', () => {
    // A: drop0 height100 → 帯[2600,2700]、B: drop200 height100 → 帯[2400,2500]。交差しても控除なし。
    const ded = beamOverlapDeductionByIdM2(
      [
        beam({ id: 'a', angleDeg: 0, dropMm: 0, heightMm: 100 }),
        beam({ id: 'b', angleDeg: 90, dropMm: 200, heightMm: 100 })
      ],
      2700
    );
    expect(ded.get('a')).toBeUndefined();
    expect(ded.get('b')).toBeUndefined();
  });

  it('重ならない離れた梁は控除なし', () => {
    const ded = beamOverlapDeductionByIdM2(
      [beam({ id: 'a', cx: 0, angleDeg: 0 }), beam({ id: 'b', cx: 5000, angleDeg: 0 })],
      2700
    );
    expect(ded.size).toBe(0);
  });

  it('梁1本では控除なし', () => {
    expect(beamOverlapDeductionByIdM2([beam({ id: 'a' })], 2700).size).toBe(0);
  });
});
