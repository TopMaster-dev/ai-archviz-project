import { describe, it, expect } from 'vitest';
import {
  SKETCH_BASE_SCALE,
  scaledToMm,
  mmToScaled,
  getWallSegment,
  getWallLengthMm,
  getRoomTransform,
  furniturePositionToMm,
  mmToFurniturePosition,
  pointInPolygon,
  isFurnitureFootprintInsidePolygon,
  furnitureFootprintCornersMm,
  getEffectiveOpeningWidthMm,
  openingRatioToWallLocalX,
  wallLocalXToOpeningRatio,
  sketchAngleToYaw,
  yawToSketchRotation,
  intersectLines2D,
  getWallBeamBandCornersMm,
  wallBeamMiterWidths,
  polygonCentroidMm,
  resolveDoorSwing3D,
  computeWallToWallSpan,
  freeBeamWallMiterCornersMm,
} from './sketchTransform.js';
import type { Point } from '../types.js';

describe('scale conversion', () => {
  it('scaledToMm / mmToScaled are inverse (1 scaled unit = 20mm at 0.05)', () => {
    expect(SKETCH_BASE_SCALE).toBe(0.05);
    expect(scaledToMm(1)).toBeCloseTo(20);
    expect(mmToScaled(20)).toBeCloseTo(1);
    expect(mmToScaled(scaledToMm(37.5))).toBeCloseTo(37.5);
  });
});

describe('wall segments', () => {
  const pts: Point[] = [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 4 },
  ];
  it('measures wall length in mm and wraps the last wall to the first point', () => {
    expect(getWallLengthMm(pts, 0)).toBeCloseTo(scaledToMm(3)); // 60mm
    expect(getWallLengthMm(pts, 1)).toBeCloseTo(scaledToMm(4)); // 80mm
    expect(getWallLengthMm(pts, 2)).toBeCloseTo(scaledToMm(5)); // closing edge 3-4-5 triangle => 100mm
  });
  it('rejects out-of-range or degenerate indices', () => {
    expect(getWallSegment(pts, 3)).toBeNull();
    expect(getWallSegment(pts, -1)).toBeNull();
    expect(getWallLengthMm(pts, 9)).toBeNull();
  });
});

describe('getRoomTransform', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ];
  it('centers the room and converts corners to metres around the centre', () => {
    const t = getRoomTransform(square);
    expect(t.centerMm.x).toBeCloseTo(20);
    expect(t.centerMm.y).toBeCloseTo(20);
    expect(t.mPoints).toHaveLength(4);
    // corner (0,0) scaled -> 0mm -> (0-20)/1000 = -0.02m on both axes
    expect(t.mPoints[0].x).toBeCloseTo(-0.02);
    expect(t.mPoints[0].z).toBeCloseTo(-0.02);
  });
  it('reports opposite winding for reversed point order', () => {
    const a = getRoomTransform(square).isCCW;
    const b = getRoomTransform([...square].reverse()).isCCW;
    expect(a).not.toBe(b);
  });
  it('handles the empty sketch safely', () => {
    const t = getRoomTransform([]);
    expect(t.mPoints).toEqual([]);
    expect(t.centerMm).toEqual({ x: 0, y: 0 });
  });
});

describe('furniture position <-> mm round trip', () => {
  it('recovers the original 3D position through the mm projection', () => {
    const centerMm: Point = { x: 20, y: 20 };
    const pos: [number, number, number] = [1, 0.5, 2];
    const mm = furniturePositionToMm(pos, centerMm);
    expect(mm).toEqual({ x: 1020, y: 2020 });
    const back = mmToFurniturePosition(mm, pos[1], centerMm);
    expect(back[0]).toBeCloseTo(1);
    expect(back[1]).toBeCloseTo(0.5);
    expect(back[2]).toBeCloseTo(2);
  });
});

describe('polygon containment', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 1000 },
    { x: 0, y: 1000 },
  ];
  it('detects inside vs outside points', () => {
    expect(pointInPolygon({ x: 500, y: 500 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1500, y: 500 }, square)).toBe(false);
  });
  it('accepts a footprint that fits and rejects one that overflows the walls', () => {
    const room: Point[] = [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 2000 },
      { x: 0, y: 2000 },
    ];
    const center: Point = { x: 1000, y: 1000 };
    expect(isFurnitureFootprintInsidePolygon(center, 0, 600, 600, room)).toBe(true);
    expect(isFurnitureFootprintInsidePolygon(center, 0, 3000, 3000, room)).toBe(false);
  });
  it('rotates footprint corners about the centre', () => {
    const corners = furnitureFootprintCornersMm({ x: 0, y: 0 }, Math.PI / 2, 200, 100);
    // 90deg rotation maps local (hw,hd)=(100,50) -> (-50,100)
    expect(corners[0].x).toBeCloseTo(-50);
    expect(corners[0].y).toBeCloseTo(100);
  });
});

describe('opening helpers', () => {
  it('adds the door frame thickness only for door types', () => {
    expect(getEffectiveOpeningWidthMm({ type: 'door_single', width: 800 })).toBe(880);
    expect(getEffectiveOpeningWidthMm({ type: 'door_sliding', width: 1600 })).toBe(1680);
    expect(getEffectiveOpeningWidthMm({ type: 'window_fix', width: 1600 })).toBe(1600);
  });
  it('maps ratio <-> wall-local X reversibly for both axis orientations', () => {
    for (const flipped of [false, true]) {
      const x = openingRatioToWallLocalX(0.25, 4000, flipped);
      expect(wallLocalXToOpeningRatio(x, 4000, flipped)).toBeCloseTo(0.25);
    }
  });
});

describe('angle conventions', () => {
  it('sketch angle <-> yaw is a sign flip and reversible', () => {
    expect(sketchAngleToYaw(0.7)).toBeCloseTo(-0.7);
    expect(yawToSketchRotation(sketchAngleToYaw(1.23))).toBeCloseTo(1.23);
  });
});

describe('wall-beam corner miter (260611 #2b)', () => {
  it('intersectLines2D returns the crossing point, null for parallel', () => {
    const p = intersectLines2D({ x: 0, y: 100 }, { x: 1, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 1 });
    expect(p?.x).toBeCloseTo(100);
    expect(p?.y).toBeCloseTo(100);
    expect(intersectLines2D({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 5 }, { x: 2, y: 0 })).toBeNull();
  });

  it('miters the inner corners against neighbouring wall-beams (square room)', () => {
    // 1000mm 角の閉ポリゴン、4辺すべてに幅100mmの壁梁。
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    const widths = new Map([
      [0, 100],
      [1, 100],
      [2, 100],
      [3, 100],
    ]);
    const corners = getWallBeamBandCornersMm(square, widths, 0);
    expect(corners).not.toBeNull();
    // 外側は壁芯の頂点
    expect(corners!.c1).toEqual({ x: 0, y: 0 });
    expect(corners!.c2).toEqual({ x: 1000, y: 0 });
    // 内側は両隣とのマイター交点（100,100）と（900,100）
    expect(corners!.c4.x).toBeCloseTo(100);
    expect(corners!.c4.y).toBeCloseTo(100);
    expect(corners!.c3.x).toBeCloseTo(900);
    expect(corners!.c3.y).toBeCloseTo(100);
  });

  it('at right-angle corners the wall-miter equals the straight inner offset (no neighbour beam)', () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    // only edge 0 has a beam → ends meet the perpendicular neighbour walls at the straight inner offset (y=100)
    const widths = new Map([[0, 100]]);
    const corners = getWallBeamBandCornersMm(square, widths, 0);
    expect(corners!.c4).toEqual({ x: 0, y: 100 });
    expect(corners!.c3).toEqual({ x: 1000, y: 100 });
  });

  it('miters the end against a SLANTED neighbour wall even with no neighbour beam (3D corner fix)', () => {
    // 直角三角形。edge0(底辺,+X)に幅100の壁梁。edge1(斜辺,45°)・edge2(左辺,垂直)は梁なし。
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 0, y: 1000 },
    ];
    const widths = new Map([[0, 100]]);
    const corners = getWallBeamBandCornersMm(tri, widths, 0);
    expect(corners).not.toBeNull();
    // 外側は壁芯の頂点
    expect(corners!.c1).toEqual({ x: 0, y: 0 });
    expect(corners!.c2).toEqual({ x: 1000, y: 0 });
    // p1側の隣(左辺)は垂直 → 直角キャップと同じ
    expect(corners!.c4.x).toBeCloseTo(0);
    expect(corners!.c4.y).toBeCloseTo(100);
    // p2側の隣(斜辺45°)に沿って端が切られる → 内側角は (900,100)（突き出し解消）
    expect(corners!.c3.x).toBeCloseTo(900);
    expect(corners!.c3.y).toBeCloseTo(100);
  });

  it('keeps the band on the INTERIOR side for a concave room (area centroid lies outside)', () => {
    // 細いL字。面積重心(≈932,932)はポリゴン外（欠き込み内）。重心ベースの内外判定だとバンドが
    // 外側へ反転するが、各辺ローカル判定なら正しく室内側へ出る。
    const L: Point[] = [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 500 },
      { x: 500, y: 500 },
      { x: 500, y: 3000 },
      { x: 0, y: 3000 },
    ];
    // 念のため重心が外であることを確認（このテストの前提）。
    const c = polygonCentroidMm(L)!;
    expect(pointInPolygon(c, L)).toBe(false);
    // edge2 = (3000,500)->(500,500): 室内は y<500 側。幅100の壁梁。
    const widths = new Map([[2, 100]]);
    const corners = getWallBeamBandCornersMm(L, widths, 2);
    expect(corners).not.toBeNull();
    // 内側バンドは下(y=400)。旧・重心判定では上(y=600)へ誤って出る。
    expect(corners!.c4.y).toBeCloseTo(400);
    expect(corners!.c3.y).toBeCloseTo(400);
  });
});

describe('wallBeamMiterWidths (3D corner: join only same-height adjacent beams)', () => {
  it('includes self + same height/drop neighbours, excludes different-height ones', () => {
    const dims = new Map([
      [0, { widthMm: 100, heightMm: 300, dropMm: 0 }],
      [1, { widthMm: 120, heightMm: 300, dropMm: 0 }], // same せい/下がり → 接合
      [3, { widthMm: 150, heightMm: 500, dropMm: 0 }], // 高さ違い → 除外（端は壁へ密着）
    ]);
    const m = wallBeamMiterWidths(dims, 0, { widthMm: 100, heightMm: 300, dropMm: 0 });
    expect(m.get(0)).toBe(100); // 自分のエッジは常に含む
    expect(m.get(1)).toBe(120); // 同高さ → 含む
    expect(m.has(3)).toBe(false); // 高さ違い → 除外
  });

  it('excludes a same-height but different-drop neighbour', () => {
    const dims = new Map([
      [0, { widthMm: 100, heightMm: 300, dropMm: 0 }],
      [1, { widthMm: 100, heightMm: 300, dropMm: 200 }], // 下がり違い → 除外
    ]);
    const m = wallBeamMiterWidths(dims, 0, { widthMm: 100, heightMm: 300, dropMm: 0 });
    expect(m.has(1)).toBe(false);
  });
});

describe('polygonCentroidMm', () => {
  it('returns the area centroid of a square and null for degenerate input', () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const c = polygonCentroidMm(square);
    expect(c!.x).toBeCloseTo(50);
    expect(c!.y).toBeCloseTo(50);
    expect(polygonCentroidMm([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
  });
});

describe('computeWallToWallSpan (260612 free-beam wall-to-wall, shared 2D/3D)', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 1000 },
    { x: 0, y: 1000 },
  ];

  it('spans a centered horizontal beam wall-to-wall', () => {
    const s = computeWallToWallSpan(square, true, 500, 500, 0);
    expect(s).not.toBeNull();
    expect(s!.lengthMm).toBeCloseTo(1000);
    expect(s!.cx).toBeCloseTo(500);
    expect(s!.cy).toBeCloseTo(500);
  });

  it('recenters an off-center beam to the wall midpoint, keeping wall-to-wall length', () => {
    const s = computeWallToWallSpan(square, true, 700, 500, 0); // +X→1000 (t300), -X→0 (t700)
    expect(s!.lengthMm).toBeCloseTo(1000);
    expect(s!.cx).toBeCloseTo(500);
    expect(s!.cy).toBeCloseTo(500);
  });

  it('works at an angle (vertical beam spans top-to-bottom)', () => {
    const s = computeWallToWallSpan(square, true, 300, 600, 90);
    expect(s!.lengthMm).toBeCloseTo(1000);
    expect(s!.cx).toBeCloseTo(300);
    expect(s!.cy).toBeCloseTo(500);
  });

  it('returns null when a ray does not hit walls on both sides (open polyline)', () => {
    const line: Point[] = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
    expect(computeWallToWallSpan(line, false, 500, 500, 0)).toBeNull();
  });

  it('reports the hit edges for each ray direction', () => {
    const s = computeWallToWallSpan(square, true, 500, 500, 0); // horizontal beam
    // +X → right wall (1000,0)-(1000,1000); -X → left wall (0,1000)-(0,0)
    expect(s!.posEdge).not.toBeNull();
    expect(s!.negEdge).not.toBeNull();
    expect(s!.posEdge!.ax).toBeCloseTo(1000);
    expect(s!.posEdge!.bx).toBeCloseTo(1000);
    expect(s!.negEdge!.ax).toBeCloseTo(0);
    expect(s!.negEdge!.bx).toBeCloseTo(0);
  });
});

describe('freeBeamWallMiterCornersMm (free-beam ends cut flush to walls)', () => {
  it('cuts both ends flush to the VERTICAL side walls (beam at 30°)', () => {
    const room: Point[] = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    // 中心(2000,1500)、30°、幅200。+方向→右壁(x=4000)、−方向→左壁(x=0)。
    const c = freeBeamWallMiterCornersMm(room, true, 2000, 1500, 30, 200);
    expect(c).not.toBeNull();
    // +端の2隅は右壁(x=4000)上＝端面が壁と面一（直角キャップの突き出しが無い）。
    expect(c!.c1.x).toBeCloseTo(4000);
    expect(c!.c2.x).toBeCloseTo(4000);
    // −端の2隅は左壁(x=0)上。
    expect(c!.c3.x).toBeCloseTo(0);
    expect(c!.c4.x).toBeCloseTo(0);
  });

  it('cuts both ends flush to the HORIZONTAL top/bottom walls (steep beam at 60°)', () => {
    const room: Point[] = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 4000 },
      { x: 0, y: 4000 },
    ];
    const c = freeBeamWallMiterCornersMm(room, true, 2000, 2000, 60, 200);
    expect(c).not.toBeNull();
    // +端は上壁(y=4000)、−端は下壁(y=0)に面一。
    expect(c!.c1.y).toBeCloseTo(4000);
    expect(c!.c2.y).toBeCloseTo(4000);
    expect(c!.c3.y).toBeCloseTo(0);
    expect(c!.c4.y).toBeCloseTo(0);
    // 端が壁に沿って切られても梁幅は保たれる（中心線方向で測る投影幅 ≒ 200）。
    const dirx = Math.cos((60 * Math.PI) / 180), diry = Math.sin((60 * Math.PI) / 180);
    const perpProj = Math.abs((c!.c1.x - c!.c2.x) * -diry + (c!.c1.y - c!.c2.y) * dirx);
    expect(perpProj).toBeCloseTo(200);
  });

  it('falls back to null for an open polyline (no wall-to-wall span)', () => {
    const line: Point[] = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
    expect(freeBeamWallMiterCornersMm(line, false, 500, 500, 30, 200)).toBeNull();
  });

  it('falls back to null (no spike) when the beam grazes the wall it ends at (~3°)', () => {
    // 細長い部屋。ほぼ水平(3°)の梁が水平な上下壁に極浅角で当たる → マイターが暴れるため矩形へ。
    const longRoom: Point[] = [
      { x: 0, y: 0 },
      { x: 10000, y: 0 },
      { x: 10000, y: 500 },
      { x: 0, y: 500 },
    ];
    expect(freeBeamWallMiterCornersMm(longRoom, true, 4800, 250, 3, 300)).toBeNull();
    // 同じ部屋でも素直な角度(45°)なら通常どおりマイターする（ガードが過剰でないこと）。
    expect(freeBeamWallMiterCornersMm(longRoom, true, 4800, 250, 45, 300)).not.toBeNull();
  });
});

describe('door swing 2D->3D linkage signs (260611 Sec1)', () => {
  it('default: hinge on p1 side, opens toward interior', () => {
    const s = resolveDoorSwing3D(false, false, true, false);
    expect(s.hingeXSign).toBe(-1); // !axisFlipped → p1 side is -X
    expect(s.openZSign).toBe(1); // +Z is interior
  });

  it('swingFlipX flips hinge side; swingFlipY flips open direction', () => {
    expect(resolveDoorSwing3D(true, false, true, false).hingeXSign).toBe(1);
    expect(resolveDoorSwing3D(false, true, true, false).openZSign).toBe(-1);
  });

  it('axis flip and exterior +Z invert the defaults (keeps 2D/3D consistent)', () => {
    const s = resolveDoorSwing3D(false, false, false, true);
    expect(s.hingeXSign).toBe(1); // axisFlipped → p1 side is +X
    expect(s.openZSign).toBe(-1); // +Z is exterior → interior is -Z
  });
});
