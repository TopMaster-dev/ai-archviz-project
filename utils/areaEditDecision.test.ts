import { describe, it, expect } from 'vitest';
import { shouldCompositeAreaEdit } from './areaEditDecision.js';

describe('shouldCompositeAreaEdit（被覆率で範囲外保護を決める・260711）', () => {
  it('テキストのみでも局所範囲は合成する＝範囲外を保護（旧: テキストのみ=非合成 が閉じ込め破れの原因だった）', () => {
    // 例: 「範囲内の椅子を消して」（参照画像なし・小領域）→ 合成して範囲外を守る
    expect(shouldCompositeAreaEdit({ placementCount: 1, fitMode: 'cover', unionCoverage: 0.05 })).toBe(true);
  });

  it('参照画像ありの局所も合成する（家具の追加/差し替え）', () => {
    expect(shouldCompositeAreaEdit({ placementCount: 1, fitMode: 'cover', unionCoverage: 0.08 })).toBe(true);
  });

  it('実質全画面（被覆≥0.85）は合成しない＝全画面直で継ぎ目なし（守る外がほぼ無い）', () => {
    expect(shouldCompositeAreaEdit({ placementCount: 1, fitMode: 'cover', unionCoverage: 0.9 })).toBe(false);
  });

  it('境界: 0.85=false（全画面直）, 0.849=true（合成して範囲外保護）', () => {
    expect(shouldCompositeAreaEdit({ placementCount: 1, fitMode: 'cover', unionCoverage: 0.85 })).toBe(false);
    expect(shouldCompositeAreaEdit({ placementCount: 1, fitMode: 'cover', unionCoverage: 0.849 })).toBe(true);
  });

  it('contain（レターボックス）/ placement 0 は合成しない', () => {
    expect(shouldCompositeAreaEdit({ placementCount: 1, fitMode: 'contain', unionCoverage: 0.3 })).toBe(false);
    expect(shouldCompositeAreaEdit({ placementCount: 0, fitMode: 'cover', unionCoverage: 0.3 })).toBe(false);
  });
});
