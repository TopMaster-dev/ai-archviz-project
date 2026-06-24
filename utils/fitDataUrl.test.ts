import { describe, it, expect } from 'vitest';
import { coverCropLossFraction } from './fitDataUrl.js';

// cover クロップで失う割合（最大軸）。> 0.1 で contain（レターボックス）にフォールバックする閾値判定に使う。
describe('coverCropLossFraction', () => {
  it('アスペクト一致なら 0（図面パース等は無クロップ）', () => {
    expect(coverCropLossFraction(16 / 9, 16 / 9)).toBeCloseTo(0);
  });

  it('横長ソースを正方へ → 幅を 25% クロップ', () => {
    expect(coverCropLossFraction(4 / 3, 1)).toBeCloseTo(0.25, 2);
  });

  it('縦長ソースを横長へ → 高さを 25% クロップ', () => {
    expect(coverCropLossFraction(1, 4 / 3)).toBeCloseTo(0.25, 2);
  });

  it('わずかなズレ（5:7 写真 vs 最近接 3:4）は閾値 0.1 未満 → cover', () => {
    expect(coverCropLossFraction(5 / 7, 3 / 4)).toBeLessThan(0.1);
  });

  it('一般的な写真比（4:3 / 16:9 / 3:2）は cover 範囲内', () => {
    expect(coverCropLossFraction(4 / 3, 4 / 3)).toBeLessThan(0.1);
    expect(coverCropLossFraction(16 / 9, 16 / 9)).toBeLessThan(0.1);
    expect(coverCropLossFraction(3 / 2, 3 / 2)).toBeLessThan(0.1);
  });

  it('極端なアスペクト差（0.45 端末画面比 vs 9:16）は閾値超え → contain', () => {
    expect(coverCropLossFraction(0.45, 9 / 16)).toBeGreaterThan(0.1);
  });

  it('不正入力はガード', () => {
    expect(coverCropLossFraction(0, 1)).toBe(0);
    expect(coverCropLossFraction(1, 0)).toBe(0);
  });
});
