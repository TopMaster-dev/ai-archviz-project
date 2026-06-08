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
