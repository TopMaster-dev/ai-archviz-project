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
  resolveDoorSwing3D,
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
    // 1000mm 角の閉ポリゴン、4辺すべてに幅100mmの壁梁。重心(500,500)。
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
    const corners = getWallBeamBandCornersMm(square, widths, 0, { x: 500, y: 500 });
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

  it('falls back to a square cap when a neighbour has no beam', () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    // only edge 0 has a beam → both ends square-capped at the straight inner offset (y=100)
    const widths = new Map([[0, 100]]);
    const corners = getWallBeamBandCornersMm(square, widths, 0, { x: 500, y: 500 });
    expect(corners!.c4).toEqual({ x: 0, y: 100 });
    expect(corners!.c3).toEqual({ x: 1000, y: 100 });
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
