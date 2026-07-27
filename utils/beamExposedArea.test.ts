import { describe, it, expect } from 'vitest';
import {
  convexIntersectionPolygon,
  areaOfPolyMinusUnion,
  occludedSideAreaMm2,
  beamExposedAreaByIdM2,
  beamSolidsFromBeams,
  type BeamSolid,
  type Pt,
} from './beamExposedArea.js';
import { convexIntersectionAreaMm2 } from './beamOverlap.js';

const ROOM = 2700;

/** 既定は「2000×200×300 の自由梁・天井フラッシュ」。上書きしたい項目だけ渡す。 */
const mk = (
  id: string,
  over: {
    cx?: number;
    cy?: number;
    lengthMm?: number;
    widthMm?: number;
    angleDeg?: number;
    dropMm?: number;
    heightMm?: number;
  } = {},
  roomHeightMm: number = ROOM,
): BeamSolid =>
  beamSolidsFromBeams(
    [
      {
        id,
        cx: 0,
        cy: 0,
        lengthMm: 2000,
        widthMm: 200,
        angleDeg: 0,
        dropMm: 0,
        heightMm: 300,
        ...over,
      },
    ],
    roomHeightMm,
  )[0];

const rectPoly = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const polyArea = (poly: Pt[]): number => {
  if (poly.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
};

const totalOf = (m: Map<string, number>): number => {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
};

/** 従来方式（各梁を独立した箱として足し上げ）の合計(m²)。控除なしの上限値。 */
const naiveSumM2 = (solids: BeamSolid[], roomHeightMm: number): number => {
  let mm2 = 0;
  for (const s of solids) {
    const h = s.topMm - s.bottomMm;
    if (!(h > 0)) continue;
    const face = polyArea(s.poly);
    if (s.topMm < roomHeightMm - 1e-6) mm2 += face;
    if (s.bottomMm > 1e-6) mm2 += face;
    for (let i = 0; i < s.poly.length; i++) {
      const p = s.poly[i];
      const q = s.poly[(i + 1) % s.poly.length];
      mm2 += Math.hypot(q.x - p.x, q.y - p.y) * h;
    }
  }
  return mm2 / 1e6;
};

// ---------------------------------------------------------------------------
// convexIntersectionPolygon
// ---------------------------------------------------------------------------

describe('convexIntersectionPolygon', () => {
  it('既存の convexIntersectionAreaMm2 と面積が一致する（同じクリップの多角形版）', () => {
    const a = rectPoly(0, 0, 10, 10);
    const b = rectPoly(5, 5, 15, 15);
    expect(polyArea(convexIntersectionPolygon(a, b))).toBeCloseTo(
      convexIntersectionAreaMm2(a, b),
      9,
    );
    expect(polyArea(convexIntersectionPolygon(a, b))).toBeCloseTo(25, 9);
  });

  it('離れていれば空配列', () => {
    expect(convexIntersectionPolygon(rectPoly(0, 0, 10, 10), rectPoly(20, 20, 30, 30))).toEqual([]);
  });

  it('内包なら小さい方の多角形（面積が一致）', () => {
    const inner = rectPoly(2, 2, 6, 6);
    expect(polyArea(convexIntersectionPolygon(rectPoly(0, 0, 10, 10), inner))).toBeCloseTo(16, 9);
  });

  it('巻き方向(CW/CCW)に依らない', () => {
    const cw = [...rectPoly(5, 5, 15, 15)].reverse();
    expect(polyArea(convexIntersectionPolygon(rectPoly(0, 0, 10, 10), cw))).toBeCloseTo(25, 9);
  });

  it('頂点数不足は空配列', () => {
    expect(convexIntersectionPolygon([{ x: 0, y: 0 }], rectPoly(0, 0, 1, 1))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// areaOfPolyMinusUnion
// ---------------------------------------------------------------------------

describe('areaOfPolyMinusUnion', () => {
  const P = rectPoly(0, 0, 10, 10); // 面積 100

  it('遮蔽なしなら P の面積', () => {
    expect(areaOfPolyMinusUnion(P, [])).toBeCloseTo(100, 9);
    expect(areaOfPolyMinusUnion(P, [rectPoly(50, 50, 60, 60)])).toBeCloseTo(100, 9);
  });

  it('1枚に半分覆われたら半分', () => {
    expect(areaOfPolyMinusUnion(P, [rectPoly(0, 0, 10, 5)])).toBeCloseTo(50, 9);
  });

  it('完全に覆われたら0（負にしない）', () => {
    expect(areaOfPolyMinusUnion(P, [rectPoly(-5, -5, 15, 15)])).toBeCloseTo(0, 9);
  });

  it('3枚が同じ領域で重なっても引きすぎない（打ち切り包除の誤りを回避）', () => {
    // Q1 = [0,2]×[0,10] = 20, Q2 = [0,10]×[0,2] = 20, Q3 = [0,2]×[0,2] = 4
    // ペア交差はいずれも [0,2]² = 4（3組とも同じ領域）。
    //   正解の和集合 = 20 + 20 − 4 = 36 → 露出 = 100 − 36 = 64
    //   単純合計で引く   : 100 − (20+20+4)      = 56 （引きすぎ）
    //   ペアまでの打ち切り: 100 − (44 − 12) = 68 （引かなすぎ）
    const Qs = [rectPoly(0, 0, 2, 10), rectPoly(0, 0, 10, 2), rectPoly(0, 0, 2, 2)];
    const area = areaOfPolyMinusUnion(P, Qs);
    expect(area).toBeCloseTo(64, 9);
    expect(area).not.toBeCloseTo(56, 6);
    expect(area).not.toBeCloseTo(68, 6);
  });

  it('4枚が入り組むケース（手計算 100 − 59 = 41）', () => {
    // Q1 = [0,10]×[0,3] = 30、Q2 = [0,3]×[0,10] = 30、Q3 = [2,5]×[2,5] = 9、Q4 = [8,10]² = 4
    //   Q1∪Q2 = 30 + 30 − 9（Q1∩Q2 = [0,3]²）        = 51
    //   Q3 のうち Q1∪Q2 に未被覆 = 9 − (3 + 3 − 1)     = 4  → 55
    //   Q4 は他と交わらない                            = 4  → 59
    //   露出 = 100 − 59 = 41
    const Qs = [
      rectPoly(0, 0, 10, 3),
      rectPoly(0, 0, 3, 10),
      rectPoly(2, 2, 5, 5),
      rectPoly(8, 8, 10, 10),
    ];
    expect(areaOfPolyMinusUnion(P, Qs)).toBeCloseTo(41, 9);
  });

  it('12枚までは厳密（同じ半分を12枚が覆う → 残り半分）', () => {
    const Qs = Array.from({ length: 12 }, () => rectPoly(0, 0, 10, 5));
    expect(areaOfPolyMinusUnion(P, Qs)).toBeCloseTo(50, 6);
  });

  it('13枚を超えると保守フォールバック（0 に張り付く・負にはならない）', () => {
    // 指数爆発回避のため Σ|A_k| をそのまま覆われ面積とみなす＝過大に覆われ判定＝露出は小さめ（安全側）。
    const Qs = Array.from({ length: 13 }, () => rectPoly(0, 0, 10, 5));
    const area = areaOfPolyMinusUnion(P, Qs);
    expect(area).toBe(0);
    expect(area).toBeGreaterThanOrEqual(0);
  });

  it('退化入力（面積0・頂点不足）は0', () => {
    expect(areaOfPolyMinusUnion([{ x: 0, y: 0 }], [])).toBe(0);
    expect(areaOfPolyMinusUnion(rectPoly(0, 0, 0, 10), [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// occludedSideAreaMm2
// ---------------------------------------------------------------------------

describe('occludedSideAreaMm2', () => {
  const other = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    bottomMm: number,
    topMm: number,
  ): BeamSolid => ({ id: 'o', poly: rectPoly(x0, y0, x1, y1), bottomMm, topMm });

  it('他の梁を貫通する区間 × 鉛直の重なり分だけ埋まる', () => {
    // 辺: (-1000,100)→(1000,100)、帯 [2200,2500]。相手 x∈[-100,100] の柱状 → s 幅 200、高さ 300。
    const occ = occludedSideAreaMm2({ x: -1000, y: 100 }, { x: 1000, y: 100 }, 2200, 2500, [
      other(-100, -1000, 100, 1000, 2200, 2500),
    ]);
    expect(occ).toBeCloseTo(200 * 300, 6);
  });

  it('鉛直が重ならなければ0（別々の露出面）', () => {
    const occ = occludedSideAreaMm2({ x: -1000, y: 100 }, { x: 1000, y: 100 }, 2200, 2500, [
      other(-100, -1000, 100, 1000, 1000, 1300),
    ]);
    expect(occ).toBe(0);
  });

  it('接しているだけ（帯の高さ0）は0', () => {
    const occ = occludedSideAreaMm2({ x: -1000, y: 100 }, { x: 1000, y: 100 }, 2200, 2500, [
      other(-100, -1000, 100, 1000, 1900, 2200),
    ]);
    expect(occ).toBe(0);
  });

  it('3本が同じ区間を覆っても1回しか引かない（和集合）', () => {
    const occ = occludedSideAreaMm2({ x: -1000, y: 100 }, { x: 1000, y: 100 }, 2200, 2500, [
      other(-100, -1000, 100, 1000, 2200, 2500),
      other(-200, -1000, 200, 1000, 2200, 2500),
      other(-300, -1000, 300, 1000, 2200, 2500),
    ]);
    // 区間は [-300,300] の 600mm 分（単純合計 200+400+600=1200 ではない）
    expect(occ).toBeCloseTo(600 * 300, 6);
  });

  it('部分的に鉛直が重なる場合は重なり高さ分だけ', () => {
    const occ = occludedSideAreaMm2({ x: -1000, y: 100 }, { x: 1000, y: 100 }, 2200, 2500, [
      other(-100, -1000, 100, 1000, 2350, 3000),
    ]);
    expect(occ).toBeCloseTo(200 * 150, 6);
  });

  it('相手の境界に乗っている辺（突き合わせ）は埋まっている扱い', () => {
    // 辺 x=2000（y 0→200）が、x∈[2000,4000] の梁の境界に一致 ＝ 立体内部の接合面。
    const occ = occludedSideAreaMm2({ x: 2000, y: 0 }, { x: 2000, y: 200 }, 2200, 2500, [
      other(2000, 0, 4000, 200, 2200, 2500),
    ]);
    expect(occ).toBeCloseTo(200 * 300, 6);
  });

  it('遮蔽物なし・退化入力は0', () => {
    expect(occludedSideAreaMm2({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 100, [])).toBe(0);
    expect(
      occludedSideAreaMm2({ x: 0, y: 0 }, { x: 0, y: 0 }, 0, 100, [other(-1, -1, 1, 1, 0, 100)]),
    ).toBe(0);
    expect(
      occludedSideAreaMm2({ x: 0, y: 0 }, { x: 100, y: 0 }, 100, 100, [
        other(-1, -1, 101, 1, 0, 100),
      ]),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// beamExposedAreaByIdM2
// ---------------------------------------------------------------------------

describe('beamExposedAreaByIdM2 — 単独の梁', () => {
  it('自由梁 2000×200×300 / 下がり200 / 天井2700 → 2.12 m²', () => {
    // 帯 [2200,2500]（top=2700−200=2500, bottom=2500−300=2200）
    //   上面 2.0m × 0.2m               = 0.40
    //   下面 2.0m × 0.2m               = 0.40
    //   長辺側面 2.0m × 0.3m × 2面     = 1.20
    //   端面   0.2m × 0.3m × 2面       = 0.12
    //   合計                            = 2.12
    const m = beamExposedAreaByIdM2([mk('a', { dropMm: 200 })], ROOM);
    expect(m.get('a')).toBeCloseTo(2.12, 6);
    expect(totalOf(m)).toBeCloseTo(2.12, 6);
  });

  it('天井フラッシュ（下がり0）は上面0 → 1.72 m²', () => {
    // 2.12 − 上面 0.40 = 1.72
    const m = beamExposedAreaByIdM2([mk('a', { dropMm: 0 })], ROOM);
    expect(m.get('a')).toBeCloseTo(1.72, 6);
  });

  it('床に達する梁は下面0 → 1.72 m²', () => {
    // 下がり2400・せい300 → 帯 [0,300]。2.12 − 下面 0.40 = 1.72
    const m = beamExposedAreaByIdM2([mk('a', { dropMm: 2400, heightMm: 300 })], ROOM);
    expect(m.get('a')).toBeCloseTo(1.72, 6);
  });

  it('寸法が非有限・非正の梁は 0', () => {
    const bad: BeamSolid[] = [
      { id: 'z1', poly: rectPoly(0, 0, 100, 100), bottomMm: 2200, topMm: 2200 }, // せい0
      { id: 'z2', poly: rectPoly(0, 0, 100, 100), bottomMm: Number.NaN, topMm: 2500 },
      { id: 'z3', poly: rectPoly(0, 0, 0, 100), bottomMm: 2200, topMm: 2500 }, // 面積0
      { id: 'z4', poly: [{ x: 0, y: 0 }], bottomMm: 2200, topMm: 2500 },
    ];
    const m = beamExposedAreaByIdM2(bad, ROOM);
    expect(m.get('z1')).toBe(0);
    expect(m.get('z2')).toBe(0);
    expect(m.get('z3')).toBe(0);
    expect(m.get('z4')).toBe(0);
    expect(totalOf(m)).toBe(0);
  });

  it('空配列は空 Map', () => {
    expect(beamExposedAreaByIdM2([], ROOM).size).toBe(0);
  });
});

describe('beamExposedAreaByIdM2 — 2本の交差（十字）', () => {
  const cross = (): BeamSolid[] => [
    mk('a', { dropMm: 200, angleDeg: 0 }),
    mk('b', { dropMm: 200, angleDeg: 90 }),
  ];

  it('十字は単独2本の合計より確実に小さく、控除は手計算どおり 0.32 m²', () => {
    // A: x∈[-1000,1000], y∈[-100,100] / B: x∈[-100,100], y∈[-1000,1000]、いずれも帯[2200,2500]。
    // 重なりの平面交差 = 200×200 = 0.04 m²。
    //   上面: 同じ高さの上面は1枚の面 → 0.04 を1回だけ計上（若い id 'a' が持つ）→ 控除 0.04
    //   下面: 同上                                                            → 控除 0.04
    //   側面: A の長辺2面が B の中を通る区間 200mm×高さ300mm = 0.06 m² ずつ埋まる
    //         B も対称に2面 → 0.06 × 4                                        → 控除 0.24
    //   控除合計 = 0.04 + 0.04 + 0.24 = 0.32
    //   露出合計 = 4.24 − 0.32 = 3.92
    // 検算（和集合立体の表面積）: 上下 = 2 × (0.4+0.4−0.04) = 1.52、
    //   十字の周長 = 4本のアーム × (900×2 + 200) = 8000mm → 側面 8.0m × 0.3m = 2.40 → 合計 3.92 ✓
    const solids = cross();
    const naive = naiveSumM2(solids, ROOM);
    expect(naive).toBeCloseTo(4.24, 6);

    const m = beamExposedAreaByIdM2(solids, ROOM);
    const total = totalOf(m);
    expect(total).toBeCloseTo(3.92, 6);
    expect(total).toBeLessThan(naive);
    expect(naive - total).toBeCloseTo(0.32, 6);
  });

  it('行ごとの内訳は若い id が共有面を持つ（合計は不変）', () => {
    const m = beamExposedAreaByIdM2(cross(), ROOM);
    // a = 0.40 + 0.40 + (0.54+0.54+0.06+0.06) = 2.00
    // b = 0.36 + 0.36 + 同上 1.20            = 1.92
    expect(m.get('a')).toBeCloseTo(2.0, 6);
    expect(m.get('b')).toBeCloseTo(1.92, 6);
  });

  it('入力順を入れ替えても合計は同じ（決定論）', () => {
    const [a, b] = cross();
    expect(totalOf(beamExposedAreaByIdM2([b, a], ROOM))).toBeCloseTo(3.92, 6);
    expect(beamExposedAreaByIdM2([b, a], ROOM).get('a')).toBeCloseTo(2.0, 6);
  });
});

describe('beamExposedAreaByIdM2 — 3本が同じ領域で重なる', () => {
  // A: x∈[-1000,1000], y∈[-100,100]（2000×200）
  // B: x∈[-100,100],  y∈[-1000,1000]（2000×200・90°）
  // C: x∈[-300,300],  y∈[-300,300]（600×600）… A∩B の中心部を丸ごと含む
  // いずれも下がり200・せい300 ＝ 帯[2200,2500]（＝上面も下面も同一平面）。
  const trio = (): BeamSolid[] => [
    mk('a', { dropMm: 200, angleDeg: 0 }),
    mk('b', { dropMm: 200, angleDeg: 90 }),
    mk('c', { dropMm: 200, lengthMm: 600, widthMm: 600, angleDeg: 0 }),
  ];

  it('水平面は打ち切り包除より大きい（＝旧方式は引きすぎ）', () => {
    // 平面交差: A∩B = 0.04、A∩C = 0.12、B∩C = 0.12、A∩B∩C = 0.04
    // 正しい footprint 和集合 = 0.40+0.40+0.36 − (0.04+0.12+0.12) + 0.04 = 0.92
    //   → 上面+下面 = 1.84
    // 旧（ペア交差の単純合計を控除）= (0.8+0.8+0.72) − 2×(0.04+0.12+0.12) = 2.32 − 0.56 = 1.76
    //   → 0.08 m² 引きすぎ。
    const [a, b, c] = trio();
    const top =
      areaOfPolyMinusUnion(a.poly, []) +
      areaOfPolyMinusUnion(b.poly, [a.poly]) +
      areaOfPolyMinusUnion(c.poly, [a.poly, b.poly]);
    expect(top / 1e6).toBeCloseTo(0.92, 6);
    expect((2 * top) / 1e6).toBeCloseTo(1.84, 6);
    expect((2 * top) / 1e6).toBeGreaterThan(1.76); // 旧方式の値より下回らない
  });

  it('合計は和集合立体の表面積 4.24 m²（行内訳 1.76 / 1.68 / 0.80）', () => {
    // A: 上0.40 下0.40 側面 = 長辺 (0.60−0.18)×2 + 端面 0.06×2 = 0.96 → 1.76
    //    （長辺 y=±100 は C が x∈[-300,300]、B が x∈[-100,100] を埋める。和集合は 600mm 分
    //      ＝ 0.6m×0.3m = 0.18。単純合計 200+600=800mm で引くと過剰控除になる）
    // B: 上0.36 下0.36 側面 0.96 → 1.68
    // C: 上0.16 下0.16 側面 = (0.18−0.06)×4 = 0.48 → 0.80
    // 合計 4.24
    // 検算（和集合立体）: footprint 0.92 ×2 = 1.84、外周 = 4×400 + 4×(700×2+200) = 8000mm
    //   → 側面 8.0×0.3 = 2.40 → 4.24 ✓
    const solids = trio();
    const m = beamExposedAreaByIdM2(solids, ROOM);
    expect(m.get('a')).toBeCloseTo(1.76, 6);
    expect(m.get('b')).toBeCloseTo(1.68, 6);
    expect(m.get('c')).toBeCloseTo(0.8, 6);
    const total = totalOf(m);
    expect(total).toBeCloseTo(4.24, 6);
    // 素の合計（控除なし）は 5.68。3本重なりでも引きすぎて 4.24 を下回らない。
    expect(naiveSumM2(solids, ROOM)).toBeCloseTo(5.68, 6);
    expect(total).toBeLessThan(naiveSumM2(solids, ROOM));
    expect(total).toBeGreaterThanOrEqual(4.24 - 1e-9);
  });

  it('順序を入れ替えても合計は同じ', () => {
    const [a, b, c] = trio();
    expect(totalOf(beamExposedAreaByIdM2([c, b, a], ROOM))).toBeCloseTo(4.24, 6);
    expect(totalOf(beamExposedAreaByIdM2([b, c, a], ROOM))).toBeCloseTo(4.24, 6);
  });
});

describe('beamExposedAreaByIdM2 — 鉛直方向の関係', () => {
  it('平面では重なるが高さが違う2本は一切控除しない', () => {
    // A 帯[2200,2500]、B 帯[1200,1500]。十字に交差するが上下に離れているので別々の面。
    const solids = [mk('a', { dropMm: 200, angleDeg: 0 }), mk('b', { dropMm: 1200, angleDeg: 90 })];
    const m = beamExposedAreaByIdM2(solids, ROOM);
    expect(m.get('a')).toBeCloseTo(2.12, 6);
    expect(m.get('b')).toBeCloseTo(2.12, 6);
    expect(totalOf(m)).toBeCloseTo(4.24, 6);
    expect(totalOf(m)).toBeCloseTo(naiveSumM2(solids, ROOM), 6);
  });

  it('積み重なり（下の梁の上端 == 上の梁の下端）は接合面を二重計上しない・負にもならない', () => {
    // A 帯[2200,2500]、B 帯[1900,2200]、footprint は同一。
    // 接合面 y=2200 は立体の内部 → A の下面も B の上面も計上しない（0回）。
    // A = 上0.40 + 下0 + 側面1.32 = 1.72、B = 上0 + 下0.40 + 側面1.32 = 1.72 → 合計 3.44
    // 検算: 和集合 = 2000×200×600 の箱 → 0.4 + 0.4 + 周長4.4m × 0.6m = 3.44 ✓
    const solids = [mk('a', { dropMm: 200 }), mk('b', { dropMm: 500 })];
    const m = beamExposedAreaByIdM2(solids, ROOM);
    expect(m.get('a')).toBeCloseTo(1.72, 6);
    expect(m.get('b')).toBeCloseTo(1.72, 6);
    expect(totalOf(m)).toBeCloseTo(3.44, 6);
    for (const v of m.values()) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('beamExposedAreaByIdM2 — 同一平面の面（隅・突き合わせ・重複）', () => {
  it('突き合わせ（端面どうしがぴったり）は接合面0・外周は1本ぶん', () => {
    // A: x∈[0,2000]、B: x∈[2000,4000]、いずれも y∈[0,200]・帯[2200,2500]。
    // 和集合 = 4000×200×300 の箱 → 上0.8 + 下0.8 + 周長8.4m×0.3m = 4.12
    const solids = [
      mk('a', { dropMm: 200, cx: 1000, cy: 100 }),
      mk('b', { dropMm: 200, cx: 3000, cy: 100 }),
    ];
    const m = beamExposedAreaByIdM2(solids, ROOM);
    expect(m.get('a')).toBeCloseTo(2.06, 6);
    expect(m.get('b')).toBeCloseTo(2.06, 6);
    expect(totalOf(m)).toBeCloseTo(4.12, 6);
  });

  it('L字の隅（同一平面・同じ向きの面）は1回だけ計上する', () => {
    // A: x∈[0,4000], y∈[0,200] / B: x∈[0,200], y∈[0,3000]、帯[2200,2500]。
    // 和集合の footprint = 0.8 + 0.6 − 0.04 = 1.36 → 上下 2.72
    // L字の外周 = 4000+200+3800+2800+200+3000 = 14000mm → 側面 14.0m × 0.3m = 4.20
    // 合計 6.92（A=4.06 / B=2.86）
    const solids = [
      mk('a', { dropMm: 200, cx: 2000, cy: 100, lengthMm: 4000, widthMm: 200, angleDeg: 0 }),
      mk('b', { dropMm: 200, cx: 100, cy: 1500, lengthMm: 3000, widthMm: 200, angleDeg: 90 }),
    ];
    const m = beamExposedAreaByIdM2(solids, ROOM);
    expect(m.get('a')).toBeCloseTo(4.06, 6);
    expect(m.get('b')).toBeCloseTo(2.86, 6);
    expect(totalOf(m)).toBeCloseTo(6.92, 6);
  });

  it('完全に同一の梁が2本（データ重複）でも1本ぶんの面積', () => {
    const solids = [mk('a', { dropMm: 200 }), mk('b', { dropMm: 200 })];
    const m = beamExposedAreaByIdM2(solids, ROOM);
    expect(m.get('a')).toBeCloseTo(2.12, 6);
    expect(m.get('b')).toBeCloseTo(0, 6);
    expect(totalOf(m)).toBeCloseTo(2.12, 6);
  });
});

// ---------------------------------------------------------------------------
// ランダム性テスト（Math.random は使わない＝CI で揺れないよう seed 固定）
// ---------------------------------------------------------------------------

/** 決定論的な擬似乱数。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('beamExposedAreaByIdM2 — 不変条件（40パターンの乱数配置）', () => {
  it('露出面積は常に 0 以上、かつ従来の独立合計以下', () => {
    const rnd = mulberry32(20260728);
    let sawDeduction = false;
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + Math.floor(rnd() * 4); // 1〜4本
      const solids = beamSolidsFromBeams(
        Array.from({ length: n }, (_, k) => ({
          id: `b${k}`,
          cx: (rnd() - 0.5) * 3000,
          cy: (rnd() - 0.5) * 3000,
          lengthMm: 500 + rnd() * 2000,
          widthMm: 100 + rnd() * 300,
          angleDeg: rnd() * 360,
          dropMm: Math.floor(rnd() * 4) * 200, // 0/200/400/600（同一高さが出るように）
          heightMm: 100 + Math.floor(rnd() * 3) * 200,
        })),
        ROOM,
      );
      const m = beamExposedAreaByIdM2(solids, ROOM);
      const naive = naiveSumM2(solids, ROOM);
      let total = 0;
      for (const v of m.values()) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(-1e-12);
        total += v;
      }
      expect(total).toBeGreaterThanOrEqual(0);
      expect(total).toBeLessThanOrEqual(naive + 1e-9);
      if (naive - total > 1e-9) sawDeduction = true;
    }
    // 重なりが1件も起きないような seed なら不変条件テストとして無意味なので、発生を確認しておく。
    expect(sawDeduction).toBe(true);
  });

  it('遠くに離れた梁を足しても他の梁の値は変わらない', () => {
    const base = [mk('a', { dropMm: 200, angleDeg: 0 }), mk('b', { dropMm: 200, angleDeg: 90 })];
    const far = mk('z', { dropMm: 200, cx: 100000, cy: 100000 });
    const m1 = beamExposedAreaByIdM2(base, ROOM);
    const m2 = beamExposedAreaByIdM2([...base, far], ROOM);
    expect(m2.get('a')).toBeCloseTo(m1.get('a') ?? 0, 9);
    expect(m2.get('b')).toBeCloseTo(m1.get('b') ?? 0, 9);
    expect(m2.get('z')).toBeCloseTo(2.12, 6);
  });
});

// ---------------------------------------------------------------------------
// 総当り（グリッドサンプリング）との突き合わせ
// ---------------------------------------------------------------------------
// 実装（凸クリップ＋包除原理＋矩形和）とは完全に別経路で「和集合立体の表面積」を数え、値を突き合わせる。
//   ・水平面 … 高さ平面ごとに「その平面を上端(下端)に持つ梁の footprint の和」から
//              「平面の少し上(下)に実体がある領域」を除いた面積をセル中心サンプリングで数える
//   ・鉛直面 … 各辺を (s=辺方向, y=高さ) 格子でサンプリングし、外向き法線側へ僅かにずらした点が
//              他の梁の内部でなければ露出とみなす
// seed 固定なので決定論的。差はグリッド解像度由来のみ（実測で相対 5e-4 未満）。

/** 凸多角形の内側判定（巻き方向は内部で正規化）。 */
function insideConvex(poly: Pt[], p: Pt): boolean {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const q = poly[i];
    const r = poly[(i + 1) % poly.length];
    a += q.x * r.y - r.x * q.y;
  }
  const ccw = a >= 0 ? poly : [...poly].reverse();
  for (let i = 0; i < ccw.length; i++) {
    const A = ccw[i];
    const B = ccw[(i + 1) % ccw.length];
    if ((B.x - A.x) * (p.y - A.y) - (B.y - A.y) * (p.x - A.x) < 0) return false;
  }
  return true;
}

function bruteForceUnionSurfaceM2(solids: BeamSolid[], roomHeightMm: number, n: number): number {
  const DELTA = 1e-3; // 面から外側へずらす量(mm)
  let mm2 = 0;
  const bboxOf = (ss: BeamSolid[]) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const s of ss) {
      for (const p of s.poly) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
    }
    return { x0, x1, y0, y1 };
  };
  const horizontal = (plane: number, up: boolean): number => {
    const owners = solids.filter((s) => Math.abs((up ? s.topMm : s.bottomMm) - plane) <= 1e-6);
    if (owners.length === 0) return 0;
    if (up ? plane >= roomHeightMm - 1e-6 : plane <= 1e-6) return 0;
    const bb = bboxOf(owners);
    const dx = (bb.x1 - bb.x0) / n;
    const dy = (bb.y1 - bb.y0) / n;
    const probe = up ? plane + DELTA : plane - DELTA;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const p = { x: bb.x0 + (i + 0.5) * dx, y: bb.y0 + (j + 0.5) * dy };
        if (!owners.some((s) => insideConvex(s.poly, p))) continue;
        if (solids.some((s) => s.bottomMm <= probe && s.topMm >= probe && insideConvex(s.poly, p)))
          continue;
        cnt++;
      }
    }
    return cnt * dx * dy;
  };

  const planes = new Set<number>();
  for (const s of solids) {
    planes.add(s.topMm);
    planes.add(s.bottomMm);
  }
  for (const plane of planes) mm2 += horizontal(plane, true) + horizontal(plane, false);

  for (let k = 0; k < solids.length; k++) {
    const s = solids[k];
    const h = s.topMm - s.bottomMm;
    const nY = Math.max(4, Math.round(n / 4));
    for (let e = 0; e < s.poly.length; e++) {
      const A = s.poly[e];
      const B = s.poly[(e + 1) % s.poly.length];
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      if (!(len > 0)) continue;
      const ux = (B.x - A.x) / len;
      const uy = (B.y - A.y) / len;
      // どちら側が外かは巻き方向に依存するので、両方向の候補から「自分の内部でない」方を採る。
      let nx = uy;
      let ny = -ux;
      const mid = { x: (A.x + B.x) / 2 + nx * DELTA, y: (A.y + B.y) / 2 + ny * DELTA };
      if (insideConvex(s.poly, mid)) {
        nx = -nx;
        ny = -ny;
      }
      const ds = len / n;
      const dyy = h / nY;
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < nY; j++) {
          const sPos = (i + 0.5) * ds;
          const yPos = s.bottomMm + (j + 0.5) * dyy;
          const p = { x: A.x + ux * sPos + nx * DELTA, y: A.y + uy * sPos + ny * DELTA };
          let buried = false;
          for (let m = 0; m < solids.length && !buried; m++) {
            if (m === k) continue;
            const o = solids[m];
            if (o.bottomMm <= yPos && o.topMm >= yPos && insideConvex(o.poly, p)) buried = true;
          }
          if (!buried) cnt++;
        }
      }
      mm2 += cnt * ds * dyy;
    }
  }
  return mm2 / 1e6;
}

describe('beamExposedAreaByIdM2 — 総当りとの突き合わせ', () => {
  it('乱数8パターンで総当り(250分割)と相対1%以内で一致する', () => {
    const rnd = mulberry32(777001);
    for (let trial = 0; trial < 8; trial++) {
      const n = 2 + Math.floor(rnd() * 3); // 2〜4本
      const solids = beamSolidsFromBeams(
        Array.from({ length: n }, (_, k) => ({
          id: `b${k}`,
          cx: (rnd() - 0.5) * 2000,
          cy: (rnd() - 0.5) * 2000,
          lengthMm: 800 + rnd() * 2000,
          widthMm: 150 + rnd() * 250,
          angleDeg: rnd() * 360,
          dropMm: Math.floor(rnd() * 3) * 200, // 同一高さ（面の共有）が出るように離散化
          heightMm: 200 + Math.floor(rnd() * 3) * 150,
        })),
        ROOM,
      );
      const mine = totalOf(beamExposedAreaByIdM2(solids, ROOM));
      const brute = bruteForceUnionSurfaceM2(solids, ROOM, 250);
      expect(mine).toBeGreaterThan(0);
      expect(Math.abs(mine - brute)).toBeLessThanOrEqual(brute * 0.01 + 1e-6);
    }
  });
});
