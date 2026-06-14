import { describe, it, expect } from 'vitest';
import { beamExposedAreaM2, wallBeamWallCoverAreaM2 } from './beamArea.js';

describe('beamExposedAreaM2 (260611 #2a: count only faces not touching wall/ceiling/floor)', () => {
  it('free beam flush to ceiling: 2 sides + 2 ends + bottom (top touches ceiling)', () => {
    // L=3,W=0.15,H=0.3, drop=0 → bottom 0.45 + 2 sides 1.8 + 2 ends 0.09 = 2.34 (top excluded)
    const a = beamExposedAreaM2({ lengthMm: 3000, widthMm: 150, heightMm: 300 });
    expect(a).toBeCloseTo(2.34, 5);
  });

  it('wall beam flush to ceiling: 1 side + bottom (top + wall side + both ends excluded)', () => {
    // sides 1*0.9 + bottom 0.45 = 1.35 (ends excluded: butt into perpendicular walls at corners)
    const a = beamExposedAreaM2({ lengthMm: 3000, widthMm: 150, heightMm: 300, wallIndex: 2 });
    expect(a).toBeCloseTo(1.35, 5);
  });

  it('dropped beam (dropMm>0) now exposes the top face too', () => {
    // wall beam, drop 300 → top 0.45 + bottom 0.45 + side 0.9 = 1.8
    const a = beamExposedAreaM2({ lengthMm: 3000, widthMm: 150, heightMm: 300, wallIndex: 2, dropMm: 300 });
    expect(a).toBeCloseTo(1.8, 5);
  });

  it('beam reaching the floor excludes the bottom face', () => {
    // wall beam, ceiling 300mm, drop 0, height 300 → bottom touches floor → only the side 0.9 remains
    const a = beamExposedAreaM2({ lengthMm: 3000, widthMm: 150, heightMm: 300, wallIndex: 2, dropMm: 0 }, 300);
    expect(a).toBeCloseTo(0.9, 5);
  });

  it('returns 0 for degenerate / non-finite dimensions', () => {
    expect(beamExposedAreaM2({ lengthMm: 0, widthMm: 150, heightMm: 300 })).toBe(0);
    expect(beamExposedAreaM2({ lengthMm: NaN, widthMm: 150, heightMm: 300 })).toBe(0);
    expect(beamExposedAreaM2({ lengthMm: 3000, widthMm: 0, heightMm: 300 })).toBe(0);
  });
});

describe('wallBeamWallCoverAreaM2 (260613: subtract wall-beam-covered strip from クロス)', () => {
  const roomH = 2700;

  it('flush wall beam fully inside the segment: length × height', () => {
    // L=3m, H=300mm, drop=0 → band [2400,2700]; segment [0,2700] → overlap 300mm → 3*0.3 = 0.9
    const a = wallBeamWallCoverAreaM2({ lengthMm: 3000, heightMm: 300, wallIndex: 1, dropMm: 0 }, 0, roomH, roomH);
    expect(a).toBeCloseTo(0.9, 5);
  });

  it('dropped beam: band shifts down but still inside the segment', () => {
    // drop=200, H=300 → band [2200,2500]; overlap with [0,2700] = 300mm → 0.9
    const a = wallBeamWallCoverAreaM2({ lengthMm: 3000, heightMm: 300, wallIndex: 1, dropMm: 200 }, 0, roomH, roomH);
    expect(a).toBeCloseTo(0.9, 5);
  });

  it('clips to the segment: beam band only partially overlaps the wainscot-upper segment', () => {
    // band [2400,2700]; upper segment [900,2700] fully contains it → 0.9
    const upper = wallBeamWallCoverAreaM2({ lengthMm: 3000, heightMm: 300, wallIndex: 1, dropMm: 0 }, 900, roomH, roomH);
    expect(upper).toBeCloseTo(0.9, 5);
    // lower (腰壁) segment [0,900] does not overlap the top band → 0
    const lower = wallBeamWallCoverAreaM2({ lengthMm: 3000, heightMm: 300, wallIndex: 1, dropMm: 0 }, 0, 900, roomH);
    expect(lower).toBe(0);
  });

  it('tall beam clipped at the segment top (does not exceed roomHeight band)', () => {
    // H=500, drop=0 → band [2200,2700]; segment [0,2700] → overlap 500mm → 3*0.5 = 1.5
    const a = wallBeamWallCoverAreaM2({ lengthMm: 3000, heightMm: 500, wallIndex: 1, dropMm: 0 }, 0, roomH, roomH);
    expect(a).toBeCloseTo(1.5, 5);
  });

  it('free beams (no wallIndex) and degenerate inputs return 0', () => {
    expect(wallBeamWallCoverAreaM2({ lengthMm: 3000, heightMm: 300, dropMm: 0 }, 0, roomH, roomH)).toBe(0);
    expect(wallBeamWallCoverAreaM2({ lengthMm: 0, heightMm: 300, wallIndex: 1 }, 0, roomH, roomH)).toBe(0);
    expect(wallBeamWallCoverAreaM2({ lengthMm: 3000, heightMm: 0, wallIndex: 1 }, 0, roomH, roomH)).toBe(0);
  });
});
