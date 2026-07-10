import { describe, it, expect } from 'vitest';
import {
  unionBBoxOfPlacements,
  padBBox,
  parseAspectRatioKey,
  snapCropToAspect,
  remapPlacementsToCrop,
  cropToImageNorm,
  shouldCropRegion,
  isLargeRegion,
  isConfinedRegion,
  CONFINED_MAX_COVERAGE,
  LARGE_REGION_COVERAGE,
  PAD_FRAC,
} from './maskCropRemap.js';
import type { NormalizedRect } from '../types.js';

const rect = (x: number, y: number, w: number, h: number): NormalizedRect => ({ x, y, width: w, height: h });
const poly = (pts: Array<[number, number]>): NormalizedRect => {
  const points = pts.map(([x, y]) => ({ x, y }));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY, points };
};

describe('isLargeRegion（大領域＝クロップ/合成せず全画面編集・260707）', () => {
  it('しきい値以上は大領域（true）', () => {
    // 幅0.35×高さ0.35=0.1225 >= 0.10
    expect(isLargeRegion({ x: 0.3, y: 0.3, w: 0.35, h: 0.35 })).toBe(true);
    // クライアント事例相当（3矩形の union bbox ≒ 0.347×0.343 ≒ 0.119）
    expect(isLargeRegion(unionBBoxOfPlacements([rect(0.345, 0.585, 0.347, 0.343)]))).toBe(true);
  });
  it('通常の単品家具（約0.08〜0.09）は小領域（false）＝従来のクロップ＋合成に残す', () => {
    expect(isLargeRegion({ x: 0.4, y: 0.55, w: 0.35, h: 0.25 })).toBe(false); // 0.0875 < 0.10
    expect(isLargeRegion({ x: 0.4, y: 0.4, w: 0.15, h: 0.15 })).toBe(false); // 0.0225
  });
  it('しきい値は 0.10（境界）', () => {
    expect(LARGE_REGION_COVERAGE).toBe(0.1);
    expect(isLargeRegion({ x: 0, y: 0, w: 0.25, h: 0.4 })).toBe(true); // 0.10 ちょうど
    expect(isLargeRegion({ x: 0, y: 0, w: 0.2, h: 0.4 })).toBe(false); // 0.08 < 0.10
  });
});

describe('isConfinedRegion（局所＝crop 経路で範囲外を送らない・260711）', () => {
  it('小〜中領域は confined（true）＝クロップして範囲外を守る', () => {
    expect(isConfinedRegion({ x: 0, y: 0, w: 0.3, h: 0.27 })).toBe(true); // 0.081（クライアントの椅子除去相当）
    expect(isConfinedRegion({ x: 0, y: 0, w: 0.15, h: 0.15 })).toBe(true); // 0.0225
    expect(isConfinedRegion({ x: 0, y: 0, w: 0.5, h: 0.5 })).toBe(true); // 0.25
  });
  it('しきい値 0.6（境界）: 0.6=非confined(false), 0.59=confined(true)', () => {
    expect(CONFINED_MAX_COVERAGE).toBe(0.6);
    expect(isConfinedRegion({ x: 0, y: 0, w: 0.6, h: 1 })).toBe(false); // 0.60 ちょうど
    expect(isConfinedRegion({ x: 0, y: 0, w: 0.59, h: 1 })).toBe(true); // 0.59
  });
});

describe('unionBBoxOfPlacements', () => {
  it('returns a single rect as-is', () => {
    const b = unionBBoxOfPlacements([rect(0.2, 0.3, 0.1, 0.4)]);
    expect(b.x).toBeCloseTo(0.2);
    expect(b.y).toBeCloseTo(0.3);
    expect(b.w).toBeCloseTo(0.1);
    expect(b.h).toBeCloseTo(0.4);
  });
  it('uses polygon points min/max (even beyond stored bbox)', () => {
    const p = poly([
      [0.2, 0.2],
      [0.5, 0.25],
      [0.4, 0.6],
    ]);
    const b = unionBBoxOfPlacements([p]);
    expect(b.x).toBeCloseTo(0.2);
    expect(b.y).toBeCloseTo(0.2);
    expect(b.w).toBeCloseTo(0.3);
    expect(b.h).toBeCloseTo(0.4);
  });
  it('unions a rect and a polygon tightly', () => {
    const b = unionBBoxOfPlacements([rect(0.1, 0.1, 0.1, 0.1), poly([[0.6, 0.6], [0.8, 0.6], [0.7, 0.9]])]);
    expect(b.x).toBeCloseTo(0.1);
    expect(b.y).toBeCloseTo(0.1);
    expect(b.x + b.w).toBeCloseTo(0.8);
    expect(b.y + b.h).toBeCloseTo(0.9);
  });
  it('empty → full frame', () => {
    expect(unionBBoxOfPlacements([])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('padBBox', () => {
  it('expands symmetrically by PAD_FRAC*maxDim for an interior box', () => {
    const b = padBBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.1 }, 0.5);
    // pad = 0.5 * max(0.2,0.1) = 0.1
    expect(b.x).toBeCloseTo(0.3);
    expect(b.y).toBeCloseTo(0.3);
    expect(b.w).toBeCloseTo(0.4);
    expect(b.h).toBeCloseTo(0.3);
  });
  it('clamps to [0,1] and never exceeds it; always contains the input (random, in-bounds)', () => {
    for (let i = 0; i < 200; i += 1) {
      const x = (i % 9) / 10; // 0..0.8
      const y = ((i * 7) % 9) / 10; // 0..0.8
      const w = Math.min(((i * 3) % 9) / 20, 1 - x); // keep x+w <= 1
      const h = Math.min(((i * 5) % 9) / 20, 1 - y); // keep y+h <= 1
      const b = padBBox({ x, y, w, h });
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-9);
      expect(b.x).toBeLessThanOrEqual(x + 1e-9);
      expect(b.y).toBeLessThanOrEqual(y + 1e-9);
      expect(b.x + b.w).toBeGreaterThanOrEqual(x + w - 1e-9);
      expect(b.y + b.h).toBeGreaterThanOrEqual(y + h - 1e-9);
    }
  });
  it('exposes a sane default pad fraction', () => {
    expect(PAD_FRAC).toBeGreaterThan(0);
    expect(PAD_FRAC).toBeLessThan(1);
  });
});

describe('parseAspectRatioKey', () => {
  it('parses W:H keys', () => {
    expect(parseAspectRatioKey('16:9')).toBeCloseTo(16 / 9);
    expect(parseAspectRatioKey('1:1')).toBe(1);
    expect(parseAspectRatioKey('3:4')).toBeCloseTo(3 / 4);
  });
  it('falls back to 16:9 on bad input', () => {
    expect(parseAspectRatioKey('')).toBeCloseTo(16 / 9);
    expect(parseAspectRatioKey('nope')).toBeCloseTo(16 / 9);
    expect(parseAspectRatioKey('0:5')).toBeCloseTo(16 / 9);
  });
});

describe('snapCropToAspect (invariants)', () => {
  const boxes: BBox[] = [
    { x: 0.4, y: 0.4, w: 0.2, h: 0.15 }, // center
    { x: 0.0, y: 0.0, w: 0.2, h: 0.2 }, // top-left corner
    { x: 0.85, y: 0.05, w: 0.12, h: 0.2 }, // right edge
    { x: 0.05, y: 0.8, w: 0.3, h: 0.15 }, // bottom edge
  ];
  type BBox = { x: number; y: number; w: number; h: number };
  const sizes: Array<[number, number]> = [
    [1024, 576],
    [1000, 1000],
    [800, 1200],
  ];

  it('always fully contains the input bbox px, stays in-bounds, and grows (never shrinks)', () => {
    for (const [imgW, imgH] of sizes) {
      for (const b of boxes) {
        const target = parseAspectRatioKey('16:9');
        const crop = snapCropToAspect(b, imgW, imgH, target);
        const bx0 = Math.floor(b.x * imgW);
        const by0 = Math.floor(b.y * imgH);
        const bx1 = Math.ceil((b.x + b.w) * imgW);
        const by1 = Math.ceil((b.y + b.h) * imgH);
        // in-bounds
        expect(crop.sx).toBeGreaterThanOrEqual(0);
        expect(crop.sy).toBeGreaterThanOrEqual(0);
        expect(crop.sx + crop.sw).toBeLessThanOrEqual(imgW);
        expect(crop.sy + crop.sh).toBeLessThanOrEqual(imgH);
        // contains bbox
        expect(crop.sx).toBeLessThanOrEqual(bx0);
        expect(crop.sy).toBeLessThanOrEqual(by0);
        expect(crop.sx + crop.sw).toBeGreaterThanOrEqual(bx1);
        expect(crop.sy + crop.sh).toBeGreaterThanOrEqual(by1);
        // grow-only
        expect(crop.sw).toBeGreaterThanOrEqual(bx1 - bx0);
        expect(crop.sh).toBeGreaterThanOrEqual(by1 - by0);
      }
    }
  });

  it('matches the target aspect within ~1px when it fits inside the image', () => {
    const imgW = 1600;
    const imgH = 1200;
    const target = parseAspectRatioKey('16:9');
    const crop = snapCropToAspect({ x: 0.4, y: 0.45, w: 0.15, h: 0.12 }, imgW, imgH, target);
    // small box far from edges → aspect should be exact within 1px
    expect(Math.abs(crop.sw - crop.sh * target)).toBeLessThanOrEqual(1.5);
  });
});

describe('remapPlacementsToCrop ↔ cropToImageNorm round-trip', () => {
  it('maps polygon vertices into crop space and back to the original', () => {
    const imgW = 1200;
    const imgH = 800;
    const crop = { sx: 200, sy: 100, sw: 600, sh: 400 };
    const p = poly([
      [0.25, 0.2],
      [0.5, 0.25],
      [0.45, 0.5],
    ]);
    const [remapped] = remapPlacementsToCrop([p], crop, imgW, imgH);
    expect(remapped.points).toBeDefined();
    remapped.points!.forEach((pt, i) => {
      const back = cropToImageNorm(pt.x, pt.y, crop, imgW, imgH);
      expect(back.x).toBeCloseTo(p.points![i].x, 6);
      expect(back.y).toBeCloseTo(p.points![i].y, 6);
    });
  });
  it('recomputes the bbox for a remapped rect and clamps to [0,1]', () => {
    const imgW = 1000;
    const imgH = 1000;
    const crop = { sx: 250, sy: 250, sw: 500, sh: 500 };
    // rect exactly covering the crop → becomes full 0..1 in crop space
    const [r] = remapPlacementsToCrop([rect(0.25, 0.25, 0.5, 0.5)], crop, imgW, imgH);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(0);
    expect(r.width).toBeCloseTo(1);
    expect(r.height).toBeCloseTo(1);
  });
});

describe('shouldCropRegion (skip guards → fall back to full-frame path)', () => {
  const baseW = 1000;
  const baseH = 1000;
  it('crops a small, centered region', () => {
    const bbox = { x: 0.4, y: 0.4, w: 0.2, h: 0.15 };
    const crop = { sx: 300, sy: 300, sw: 400, sh: 300 };
    expect(shouldCropRegion(bbox, crop, baseW, baseH)).toBe(true);
  });
  it('skips when the crop covers >85% of the frame', () => {
    const bbox = { x: 0.05, y: 0.05, w: 0.5, h: 0.5 };
    const crop = { sx: 0, sy: 0, sw: 950, sh: 950 };
    expect(shouldCropRegion(bbox, crop, baseW, baseH)).toBe(false);
  });
  it('skips when the mask itself covers >60% of the frame', () => {
    const bbox = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    const crop = { sx: 50, sy: 50, sw: 700, sh: 700 };
    expect(shouldCropRegion(bbox, crop, baseW, baseH)).toBe(false);
  });
  it('skips when the crop is smaller than the min px on a side (over-upscale)', () => {
    const bbox = { x: 0.48, y: 0.48, w: 0.03, h: 0.03 };
    const crop = { sx: 480, sy: 480, sw: 40, sh: 40 };
    expect(shouldCropRegion(bbox, crop, baseW, baseH)).toBe(false);
  });
});
