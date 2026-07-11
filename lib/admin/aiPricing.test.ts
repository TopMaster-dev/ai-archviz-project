import { describe, it, expect } from 'vitest';
import { priceForModel, estimateEventCostUsd, hasKnownPrice } from './aiPricing.js';

describe('priceForModel（前方一致）', () => {
  it('完全一致・バージョン付き前方一致を解決', () => {
    expect(priceForModel('replicate:remove-object')?.perCallUsd).toBe(0.0006);
    expect(priceForModel('gemini-3-pro-image-preview')?.perImageUsd).toBe(0.134);
    expect(priceForModel('gemini-2.5-flash-image-preview')?.perImageUsd).toBe(0.039);
  });
  it('未知モデル/空は null', () => {
    expect(priceForModel('unknown-model')).toBeNull();
    expect(priceForModel('')).toBeNull();
    expect(priceForModel(null)).toBeNull();
  });
});

describe('estimateEventCostUsd', () => {
  it('per-call エンジンは画像枚数ぶん（最低1）', () => {
    expect(estimateEventCostUsd({ model: 'replicate:remove-object', imageCount: 1 })).toBeCloseTo(0.0006, 6);
    expect(estimateEventCostUsd({ model: 'replicate:flux-fill-pro', imageCount: 1 })).toBeCloseTo(0.05, 6);
  });
  it('per-image モデルは画像枚数ぶん', () => {
    expect(estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 1 })).toBeCloseTo(0.134, 6);
    expect(estimateEventCostUsd({ model: 'gemini-2.5-flash-image', imageCount: 2 })).toBeCloseTo(0.078, 6);
  });
  it('imageCount 0/未指定でも最低1回として概算', () => {
    expect(estimateEventCostUsd({ model: 'replicate:remove-object', imageCount: 0 })).toBeCloseTo(0.0006, 6);
  });
  it('単価不明は 0', () => {
    expect(estimateEventCostUsd({ model: 'unknown', imageCount: 5 })).toBe(0);
  });
});

describe('hasKnownPrice', () => {
  it('既知/未知を判定', () => {
    expect(hasKnownPrice('gemini-3-pro-image-preview')).toBe(true);
    expect(hasKnownPrice('replicate:flux-fill-pro')).toBe(true);
    expect(hasKnownPrice('mystery')).toBe(false);
  });
});
