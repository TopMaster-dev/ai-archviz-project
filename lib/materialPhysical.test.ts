import { describe, it, expect } from 'vitest';
import {
  effectiveTextureShortEdgeMeters,
  deriveMaterialPhysical,
  parseMaterialFilename,
  type MaterialPhysical,
} from './materialPhysical.js';

const phys = (w?: number, h?: number): MaterialPhysical => ({
  repeatWidthMm: w,
  repeatHeightMm: h,
  imageKind: 'repeat',
  source: 'filename+pixels',
});

describe('effectiveTextureShortEdgeMeters', () => {
  it('uses the manual textureScale override when provided', () => {
    expect(effectiveTextureShortEdgeMeters(phys(200, 200), 0.5)).toBe(0.5);
  });

  it('derives the short edge (m) from physical mm when no override', () => {
    expect(effectiveTextureShortEdgeMeters(phys(200, 300))).toBeCloseTo(0.2);
    expect(effectiveTextureShortEdgeMeters(phys(1000, 1000))).toBeCloseTo(1.0);
  });

  it('falls back to 1.0m when neither override nor physical size is available', () => {
    expect(effectiveTextureShortEdgeMeters(undefined)).toBe(1);
    expect(effectiveTextureShortEdgeMeters({ imageKind: 'unknown', source: 'none' })).toBe(1);
  });
});

describe('deriveMaterialPhysical / parseMaterialFilename (1mm=1px spec)', () => {
  it('parses the P/C/R/K identification code from the filename', () => {
    expect(parseMaterialFilename('AB-1_20260101R01').kind).toBe('repeat');
    expect(parseMaterialFilename('AB-1_20260101C01').kind).toBe('chip');
    expect(parseMaterialFilename('AB-1_20260101K0103').combinationCode).toBe('K01');
  });

  it('reads real mm from pixel size for a repeat (R) image (1mm=1px)', () => {
    const p = deriveMaterialPhysical({
      publicId: 'materials/sangetsu/floor/AB-1_20260101R01',
      widthPx: 200,
      heightPx: 300,
    });
    expect(p.imageKind).toBe('repeat');
    expect(p.repeatWidthMm).toBe(200);
    expect(p.repeatHeightMm).toBe(300);
    expect(p.source).toBe('filename+pixels');
  });

  it('converts a chip (C) image at 200dpi (300px ≈ 38mm)', () => {
    const p = deriveMaterialPhysical({
      publicId: 'materials/sangetsu/wall/AB-2_20260101C01',
      widthPx: 300,
      heightPx: 300,
    });
    expect(p.imageKind).toBe('chip');
    expect(p.repeatWidthMm).toBeCloseTo(38.1, 1);
  });
});
