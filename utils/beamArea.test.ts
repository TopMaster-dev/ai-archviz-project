import { describe, it, expect } from 'vitest';
import { beamExposedAreaM2 } from './beamArea.js';

describe('beamExposedAreaM2', () => {
  it('free beam excludes only the top face (4 verticals + bottom)', () => {
    // L=3, W=0.15, H=0.3 → ends 2*0.045 + bottom 0.45 + sides 2*0.9 = 2.34
    const a = beamExposedAreaM2({ lengthMm: 3000, widthMm: 150, heightMm: 300 });
    expect(a).toBeCloseTo(2.34, 5);
  });

  it('wall beam also excludes the wall-facing long side', () => {
    // sides = 1*0.9 → 0.09 + 0.45 + 0.9 = 1.44
    const a = beamExposedAreaM2({ lengthMm: 3000, widthMm: 150, heightMm: 300, wallIndex: 2 });
    expect(a).toBeCloseTo(1.44, 5);
  });

  it('returns 0 for degenerate / non-finite dimensions', () => {
    expect(beamExposedAreaM2({ lengthMm: 0, widthMm: 150, heightMm: 300 })).toBe(0);
    expect(beamExposedAreaM2({ lengthMm: NaN, widthMm: 150, heightMm: 300 })).toBe(0);
    expect(beamExposedAreaM2({ lengthMm: 3000, widthMm: 0, heightMm: 300 })).toBe(0);
  });
});
