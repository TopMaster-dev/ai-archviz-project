import { describe, it, expect } from 'vitest';
import { pickClosestCropRatio, maxCropForRatio, CROP_RATIOS } from './cropToAspect.js';

describe('pickClosestCropRatio（最寄りの対応比率・260703）', () => {
  it('ぴったり一致する比率を選ぶ', () => {
    expect(pickClosestCropRatio(1600, 900).key).toBe('16:9');
    expect(pickClosestCropRatio(1000, 1000).key).toBe('1:1');
    expect(pickClosestCropRatio(1200, 1600).key).toBe('3:4');
  });

  it('用紙比率(1:1.414・縦)の最寄りは 2:3 か 3:4（1:1.414 自体は非対応）', () => {
    const key = pickClosestCropRatio(1000, 1414).key;
    expect(['2:3', '3:4']).toContain(key);
    // 対応比率リストに 1:1.414 は含まれない。
    expect(CROP_RATIOS.some((c) => Math.abs(c.ratio - 1 / 1.414) < 1e-4)).toBe(false);
  });

  it('僅かにズレた比率も最寄りへ丸める', () => {
    expect(pickClosestCropRatio(1610, 900).key).toBe('16:9'); // ≈16:9
    expect(pickClosestCropRatio(1050, 1000).key).toBe('1:1'); // ≈1:1
  });

  it('不正寸法は先頭(1:1)にフォールバック', () => {
    expect(pickClosestCropRatio(0, 100).key).toBe('1:1');
    expect(pickClosestCropRatio(100, 0).key).toBe('1:1');
  });
});

describe('maxCropForRatio（最大クロップ矩形・トリミング最小）', () => {
  it('同一比率はクロップ無し（全体）', () => {
    const r = maxCropForRatio(1600, 900, 16 / 9);
    expect(r.w).toBeCloseTo(1600, 3);
    expect(r.h).toBeCloseTo(900, 3);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(0);
  });

  it('横長画像を 1:1 に切る（高さ使い切り・幅を絞る・中央）', () => {
    const r = maxCropForRatio(1600, 900, 1);
    expect(r.h).toBeCloseTo(900);
    expect(r.w).toBeCloseTo(900);
    expect(r.x).toBeCloseTo((1600 - 900) / 2); // 中央
    expect(r.y).toBeCloseTo(0);
  });

  it('縦長画像を 1:1 に切る（幅使い切り・高さを絞る・中央）', () => {
    const r = maxCropForRatio(900, 1600, 1);
    expect(r.w).toBeCloseTo(900);
    expect(r.h).toBeCloseTo(900);
    expect(r.y).toBeCloseTo((1600 - 900) / 2);
  });

  it('offset で位置が動く（左上/右下）', () => {
    const tl = maxCropForRatio(1600, 900, 1, 0, 0);
    expect(tl.x).toBeCloseTo(0);
    const br = maxCropForRatio(1600, 900, 1, 1, 1);
    expect(br.x).toBeCloseTo(1600 - 900);
  });

  it('切り出した矩形は目標比率になる', () => {
    const r = maxCropForRatio(1234, 987, 3 / 2);
    expect(r.w / r.h).toBeCloseTo(3 / 2, 4);
  });
});
