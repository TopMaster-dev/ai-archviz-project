import { describe, it, expect } from 'vitest';
import { sizeForLongEdge } from './normalizeAiEditBase.js';
import { PREVIEW_GEMINI_LONG_EDGE, ENABLE_2K_PREVIEW } from './printExportSpec.js';

/**
 * 「AIで写真編集」と「図面からパース作成」の出力サイズを揃える（260812 クライアント要望）。
 *
 * 1つ目の版の寸法が、そのプロジェクトの出力サイズを最後まで決める
 * （以後のAI編集は生成結果をこの寸法へ合わせ直して保存するため）。
 * レンダリング側は生成結果そのものが1つ目の版なので常に 2K ネイティブ長辺。
 * 写真側も取り込み時に同じ長辺へ揃える。ここが狂うと、片方だけ小さい画像が出続ける。
 */

const TARGET = PREVIEW_GEMINI_LONG_EDGE;

describe('取り込み写真の寸法を生成側へ揃える', () => {
  it('大きい写真は縮小して長辺を合わせる', () => {
    const out = sizeForLongEdge(4000, 3000, TARGET);
    expect(Math.max(out.w, out.h)).toBe(TARGET);
  });

  it('小さい写真は拡大して長辺を合わせる（揃えないと生成結果を毎回潰すことになる）', () => {
    const out = sizeForLongEdge(1200, 800, TARGET);
    expect(Math.max(out.w, out.h)).toBe(TARGET);
  });

  it('縦横比は変えない（構図が変わってはいけない）', () => {
    for (const [w, h] of [
      [4000, 3000],
      [1200, 800],
      [1080, 1920],
      [2688, 1512],
      [1000, 1000],
    ] as const) {
      const out = sizeForLongEdge(w, h, TARGET);
      expect(out.w / out.h, `${w}x${h}`).toBeCloseTo(w / h, 2);
    }
  });

  it('縦長でも長辺（高さ）が基準になる', () => {
    const out = sizeForLongEdge(1080, 1920, TARGET);
    expect(out.h).toBe(TARGET);
    expect(out.w).toBeLessThan(out.h);
  });

  it('既に一致していれば寸法は変わらない', () => {
    const out = sizeForLongEdge(TARGET, Math.round((TARGET * 9) / 16), TARGET);
    expect(out.w).toBe(TARGET);
  });

  it('正方形は両辺が長辺になる', () => {
    const out = sizeForLongEdge(500, 500, TARGET);
    expect(out).toEqual({ w: TARGET, h: TARGET });
  });

  it('壊れた入力でも 1px 未満にならない（0除算・NaNで落ちない）', () => {
    for (const [w, h] of [
      [0, 0],
      [-10, -10],
      [NaN, 100],
      [100, NaN],
    ] as const) {
      const out = sizeForLongEdge(w as number, h as number, TARGET);
      expect(out.w).toBeGreaterThanOrEqual(1);
      expect(out.h).toBeGreaterThanOrEqual(1);
    }
  });

  it('レンダリング側の長辺と同じ定数を使っている（2K/1K の切替に追従する）', () => {
    expect(TARGET).toBe(ENABLE_2K_PREVIEW ? 2688 : 1344);
  });
});
