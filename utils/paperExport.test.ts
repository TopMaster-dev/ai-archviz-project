import { describe, it, expect } from 'vitest';
import {
  paperPixelDims,
  orientationForImage,
  paperAspectRatio,
  PAPER_MM,
} from './paperExport.js';

describe('paperPixelDims（用紙のピクセル寸法・260703 第3段）', () => {
  it('A4 縦 300dpi ≈ 2480×3508', () => {
    const d = paperPixelDims('A4', 300, 'portrait');
    expect(d.w).toBe(2480);
    expect(d.h).toBe(3508);
  });
  it('A4 横は縦の幅高さを入れ替え', () => {
    const p = paperPixelDims('A4', 300, 'portrait');
    const l = paperPixelDims('A4', 300, 'landscape');
    expect(l.w).toBe(p.h);
    expect(l.h).toBe(p.w);
  });
  it('A3 縦 300dpi ≈ 3508×4961', () => {
    const d = paperPixelDims('A3', 300, 'portrait');
    expect(d.w).toBe(3508);
    expect(d.h).toBe(4961);
  });
  it('dpi に比例（150dpi は 300dpi の約半分）', () => {
    const a = paperPixelDims('A4', 300, 'portrait');
    const b = paperPixelDims('A4', 150, 'portrait');
    expect(b.w).toBeCloseTo(a.w / 2, -1);
    expect(b.h).toBeCloseTo(a.h / 2, -1);
  });
});

describe('用紙の縦横比 ≈ 1:1.414（√2）', () => {
  it('各サイズ・各向きで長辺/短辺 ≈ 1.414', () => {
    (['A4', 'A3'] as const).forEach((paper) => {
      const { short, long } = PAPER_MM[paper];
      expect(long / short).toBeCloseTo(1.414, 2);
      expect(paperAspectRatio(paper, 'portrait')).toBeCloseTo(short / long, 5);
      expect(paperAspectRatio(paper, 'landscape')).toBeCloseTo(long / short, 5);
    });
  });
});

describe('orientationForImage', () => {
  it('横長→landscape、縦長→portrait、正方→portrait', () => {
    expect(orientationForImage(1600, 900)).toBe('landscape');
    expect(orientationForImage(900, 1600)).toBe('portrait');
    expect(orientationForImage(1000, 1000)).toBe('portrait');
  });
});
