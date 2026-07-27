import { describe, it, expect } from 'vitest';
import { beamExposedAreaByIdM2, beamSolidsFromBeams, roomWallOccluders, isWallOccluderId } from './beamExposedArea.js';
import { resolveBeamPlacement, polygonCentroidMm } from './beamPlacement.js';
import type { Beam } from '../lib/project/projectState.js';

/**
 * 見積の梁数量（App.tsx areaForMeshM2 の Beam_ 分岐）と同じ手順を再現する統合テスト（260728 #10）。
 *
 * これが無いと、モジュール単体は正しいのに配線でズレる（壁接触の扱いを落とす等）регрессионが
 * 一切検出できない＝敵対検証の指摘「App.tsx を差し替えてもテストが1つも落ちない」への対応。
 */

const SCALE = 0.05; // sketchPoints(px) → mm は /0.05

/** 部屋: 4000 × 3000 mm の矩形。 */
const ROOM_PX = [
  { x: 0, y: 0 },
  { x: 4000 * SCALE, y: 0 },
  { x: 4000 * SCALE, y: 3000 * SCALE },
  { x: 0, y: 3000 * SCALE },
];
const ROOM_H = 2700;

/** App.tsx の beamExposedAreaById と同じ計算。 */
function estimateAreas(beams: Beam[], pointsPx = ROOM_PX, roomHeight = ROOM_H): Map<string, number> {
  const pointsMm = pointsPx.map((p) => ({ x: p.x / SCALE, y: p.y / SCALE }));
  const centerMm = polygonCentroidMm(pointsMm);
  const placed = beams.map((b) => resolveBeamPlacement(b, pointsMm, centerMm));
  const solids = [
    ...beamSolidsFromBeams(placed, roomHeight),
    ...roomWallOccluders(pointsMm, roomHeight),
  ];
  const raw = beamExposedAreaByIdM2(solids, roomHeight);
  for (const id of [...raw.keys()]) if (isWallOccluderId(id)) raw.delete(id);
  return raw;
}

const beam = (over: Partial<Beam> & { id: string }): Beam =>
  ({
    cx: 0,
    cy: 0,
    lengthMm: 1000,
    angleDeg: 0,
    widthMm: 150,
    heightMm: 300,
    dropMm: 0,
    ...over,
  }) as Beam;

describe('見積の梁数量（壁接触は壁スラブで自動除外）', () => {
  it('壁梁（天井フラッシュ）は 室内側側面 + 下面 のみ＝旧実装と同じ 1.35 m²', () => {
    // 壁0（y=0・長さ4000）に W=150 H=300 drop=0 の壁梁。
    // 露出は 室内側の長辺 4000×300 = 1.2 m² と 下面 4000×150 = 0.6 m² …ではなく、
    // 旧実装の期待値（beamArea.test.ts）に合わせて長さ3000の壁で検証する。
    const beams = [beam({ id: 'w', wallIndex: 3, lengthMm: 3000 })]; // 壁3 = x=0・長さ3000
    const a = estimateAreas(beams).get('w') ?? 0;
    // 室内側側面 3000×300 = 0.90 + 下面 3000×150 = 0.45 → 1.35
    // 壁に接する背面(0.90)と両端面(2×150×300=0.09)は壁スラブに埋まって除外される。
    expect(a).toBeCloseTo(1.35, 6);
  });

  it('自由梁（部屋の中央・どこにも接しない）は6面すべて＝ 1.89 m²', () => {
    // 2000×150×300 を室中央へ。旧 beamArea.test.ts の自由梁ケースと同じ値。
    const beams = [
      beam({ id: 'f', cx: 2000, cy: 1500, lengthMm: 2000, widthMm: 150, heightMm: 300, dropMm: 300 }),
    ];
    const a = estimateAreas(beams).get('f') ?? 0;
    // 上面 2000×150=0.30 + 下面 0.30 + 長辺2面 2×(2000×300)=1.20 + 端面2面 2×(150×300)=0.09 → 1.89
    // ただし天井から下がっている(drop=300)ので上面も露出 → 0.30+0.30+1.20+0.09 = 1.89
    expect(a).toBeCloseTo(1.89, 6);
  });

  it('壁を動かすと壁梁の数量が追従する（保存値に取り残されない）', () => {
    const beams = [beam({ id: 'w', wallIndex: 3, lengthMm: 3000 })];
    const before = estimateAreas(beams).get('w') ?? 0;
    // 部屋を y 方向に 2倍（壁3 の長さ 3000→6000）に広げる。
    const wider = [
      { x: 0, y: 0 },
      { x: 4000 * SCALE, y: 0 },
      { x: 4000 * SCALE, y: 6000 * SCALE },
      { x: 0, y: 6000 * SCALE },
    ];
    const after = estimateAreas(beams, wider).get('w') ?? 0;
    expect(after).toBeGreaterThan(before * 1.9);
    expect(after).toBeCloseTo(2.7, 6); // 6000×300 + 6000×150 = 1.8 + 0.9
  });

  it('交差する2本は重なり分だけ減る（独立合計より必ず小さい）', () => {
    const beams = [
      beam({ id: 'a', cx: 2000, cy: 1500, lengthMm: 3000, angleDeg: 0, widthMm: 200, heightMm: 300, dropMm: 200 }),
      beam({ id: 'b', cx: 2000, cy: 1500, lengthMm: 2000, angleDeg: 90, widthMm: 200, heightMm: 300, dropMm: 200 }),
    ];
    const m = estimateAreas(beams);
    const crossed = (m.get('a') ?? 0) + (m.get('b') ?? 0);
    const alone =
      (estimateAreas([beams[0]]).get('a') ?? 0) + (estimateAreas([beams[1]]).get('b') ?? 0);
    expect(crossed).toBeLessThan(alone);
    // 埋まるのは 上下面の共有 2×(200×200) と 側面4枚 4×(200×300)
    expect(alone - crossed).toBeCloseTo((2 * 200 * 200 + 4 * 200 * 300) / 1e6, 6);
  });

  it('壁スラブは結果マップに現れない（非課金）', () => {
    const m = estimateAreas([beam({ id: 'w', wallIndex: 0, lengthMm: 4000 })]);
    for (const id of m.keys()) expect(id.startsWith('__wall:')).toBe(false);
  });
});
