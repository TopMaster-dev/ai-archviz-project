import { describe, it, expect } from 'vitest';
import { sizeForLongEdge, measuredGeneratedSize, FALLBACK_LONG_EDGE } from './normalizeAiEditBase.js';
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

/**
 * 【260820 クライアント指摘】写真PJでも構図が拡大される件。
 *
 * 図面PJは版1が生成画像そのものなので、版1と生成結果の幾何は定義上一致する。
 * 写真PJの版1は利用者の写真で、寸法をこちらで決めるため、合わせないとずれる。
 * ずれると (1)モデルへの入力と要求出力の解像度が食い違い (2)版寸法へ戻す際の
 * 中央クロップが編集ごとに蓄積する、の2つが同時に起きる。
 */
describe('写真の版1を生成結果と同じ幾何へ合わせる', () => {
  /** fitDataUrl の cover と同じ計算で、1回の編集で残る画角の割合を出す。 */
  const coverKeep = (sw: number, sh: number, tw: number, th: number) => {
    const sa = sw / sh;
    const da = tw / th;
    return sa > da ? Math.round(sh * da) / sw : Math.round(sw / da) / sh;
  };
  const GEN = { w: 2752, h: 1536 }; // 実測（16:9 要求時）

  it('16:9 は実測寸法（生成結果と同一）を返す', () => {
    // 正確な16:9でクロップされた写真（比 1.77778）から、生成の実比 1.79167 の寸法へ。
    expect(measuredGeneratedSize(3840, 2160)).toEqual({ w: 2752, h: 1536 });
  });

  it('合わせた版1では編集を重ねてもクロップが起きない', () => {
    const t = measuredGeneratedSize(3840, 2160)!;
    let keep = 1;
    for (let i = 0; i < 10; i += 1) keep *= coverKeep(GEN.w, GEN.h, t.w, t.h);
    expect(keep).toBe(1); // 10回編集しても画角100%
  });

  it('従来の長辺2688では編集ごとにクロップが蓄積していた（回帰の記録）', () => {
    let keep = 1;
    for (let i = 0; i < 10; i += 1) keep *= coverKeep(GEN.w, GEN.h, 2688, 1512);
    expect(keep).toBeLessThan(0.95); // 実測 92.6%
  });

  it('未実測の比率は null（推測値を返さない）', () => {
    // テーブルに載っているのは実測できた比率だけ。載っていないものは
    // 呼び出し側が長辺のみ合わせる暫定動作へ落ちる。
    expect(measuredGeneratedSize(1000, 1000)).toBeNull(); // 1:1 は未実測
  });

  it('壊れた寸法では null', () => {
    expect(measuredGeneratedSize(0, 100)).toBeNull();
    expect(measuredGeneratedSize(100, 0)).toBeNull();
    expect(measuredGeneratedSize(NaN, 100)).toBeNull();
  });

  it('暫定の長辺は実測の2K長辺と一致する（2688に戻さない）', () => {
    expect(FALLBACK_LONG_EDGE).toBe(2752);
  });
});
