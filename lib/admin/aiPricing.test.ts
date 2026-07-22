import { describe, it, expect } from 'vitest';
import { priceForModel, estimateEventCostUsd, hasKnownPrice } from './aiPricing.js';

describe('priceForModel（前方一致）', () => {
  it('完全一致・バージョン付き前方一致を解決', () => {
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
  it('per-image モデルは画像枚数ぶん', () => {
    expect(estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 1 })).toBeCloseTo(0.134, 6);
    expect(estimateEventCostUsd({ model: 'gemini-2.5-flash-image', imageCount: 2 })).toBeCloseTo(0.078, 6);
  });
  it('imageCount 0/未指定でも最低1回として概算', () => {
    expect(estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 0 })).toBeCloseTo(0.134, 6);
  });
  it('単価不明は 0', () => {
    expect(estimateEventCostUsd({ model: 'unknown', imageCount: 5 })).toBe(0);
  });
});

describe('hasKnownPrice', () => {
  it('既知/未知を判定', () => {
    expect(hasKnownPrice('gemini-3-pro-image-preview')).toBe(true);
    expect(hasKnownPrice('mystery')).toBe(false);
  });
});

describe('estimateEventCostUsd（トークン従量・260722）', () => {
  it('Gemini画像は入力$2/1M＋画像出力$120/1M で算出', () => {
    // 入力1350・出力1120 → (1350*2 + 1120*120)/1e6
    expect(
      estimateEventCostUsd({ model: 'gemini-3-pro-image-preview', imageCount: 1, inputTokens: 1350, outputTokens: 1120 }),
    ).toBeCloseTo((1350 * 2 + 1120 * 120) / 1_000_000, 9);
  });
  it('入力トークンが違えば費用も変わる（旧・固定額¥20問題の解消）', () => {
    const a = estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 1, inputTokens: 1350, outputTokens: 1120 });
    const b = estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 1, inputTokens: 3811, outputTokens: 1120 });
    expect(b).toBeGreaterThan(a);
  });
  it('4K画像（出力2000tok）は2K（1120tok）より高い', () => {
    const k2 = estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 1, inputTokens: 1000, outputTokens: 1120 });
    const k4 = estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 1, inputTokens: 1000, outputTokens: 2000 });
    expect(k4).toBeGreaterThan(k2);
  });
  it('テキスト（エージェント）は出力$12/1M', () => {
    expect(
      estimateEventCostUsd({ model: 'gemini-3-pro-preview', imageCount: 0, inputTokens: 1000, outputTokens: 500 }),
    ).toBeCloseTo((1000 * 2 + 500 * 12) / 1_000_000, 9);
  });
  it('トークン0なら画像1枚のフォールバックに戻る（後方互換）', () => {
    expect(
      estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 1, inputTokens: 0, outputTokens: 0 }),
    ).toBeCloseTo(0.134, 6);
  });
});

describe('priceForModel（最長一致・画像優先）', () => {
  it('-image はテキスト単価に負けない（出力単価で判別）', () => {
    expect(priceForModel('gemini-3-pro-image-preview')?.outputPerMTok).toBe(120);
    expect(priceForModel('gemini-3-pro-preview')?.outputPerMTok).toBe(12);
  });
  it('既定エージェントモデル gemini-2.5-flash はテキスト単価を持つ（$0で計上されない）', () => {
    expect(priceForModel('gemini-2.5-flash')?.outputPerMTok).toBe(2.5);
    expect(hasKnownPrice('gemini-2.5-flash')).toBe(true);
    // 画像バリアントは従来どおり per-image（回帰しない）。
    expect(priceForModel('gemini-2.5-flash-image-preview')?.perImageUsd).toBe(0.039);
  });
  it('エージェント相談の費用が0でなくなる', () => {
    expect(
      estimateEventCostUsd({ model: 'gemini-2.5-flash', imageCount: 0, inputTokens: 2000, outputTokens: 800 }),
    ).toBeCloseTo((2000 * 0.3 + 800 * 2.5) / 1_000_000, 9);
  });
});

describe('画像モデルで出力トークン欠落時は画像1枚を下限にする', () => {
  it('output_tokens=0 でも入力だけの過少計上にならない', () => {
    const c = estimateEventCostUsd({ model: 'gemini-3-pro-image', imageCount: 1, inputTokens: 1500, outputTokens: 0 });
    expect(c).toBeCloseTo(0.134, 6); // 入力だけ($0.003)ではなく画像1枚の単価
  });
});

describe('専用エンジン（暫定単価）', () => {
  it('replicate/bria は per-call で概算（* 対象外＝単価既知）', () => {
    expect(hasKnownPrice('bria:eraser')).toBe(true);
    expect(estimateEventCostUsd({ model: 'replicate:remove-object', imageCount: 1 })).toBeCloseTo(0.01, 6);
  });
});
