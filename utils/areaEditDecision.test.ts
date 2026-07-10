import { describe, it, expect } from 'vitest';
import { shouldCompositeAreaEdit } from './areaEditDecision.js';

describe('shouldCompositeAreaEdit（継ぎ目 vs 湧き出しの切り分け・260710）', () => {
  it('テキストのみ（参照画像なし）の編集は合成しない＝全画面のまま＝継ぎ目を出さない', () => {
    // 例: 「窓の外を昼にして」「照明を追加して」
    expect(
      shouldCompositeAreaEdit({ hasReferenceImage: false, placementCount: 2, fitMode: 'cover' })
    ).toBe(false);
    expect(
      shouldCompositeAreaEdit({ hasReferenceImage: false, placementCount: 1, fitMode: 'cover' })
    ).toBe(false);
  });

  it('参照画像あり（家具の追加/差し替え）は合成する＝湧き出し防止', () => {
    expect(
      shouldCompositeAreaEdit({ hasReferenceImage: true, placementCount: 1, fitMode: 'cover' })
    ).toBe(true);
  });

  it('placement が無ければ合成しない', () => {
    expect(
      shouldCompositeAreaEdit({ hasReferenceImage: true, placementCount: 0, fitMode: 'cover' })
    ).toBe(false);
  });

  it('contain（レターボックス）時は座標がズレるので合成しない', () => {
    expect(
      shouldCompositeAreaEdit({ hasReferenceImage: true, placementCount: 1, fitMode: 'contain' })
    ).toBe(false);
  });
});
