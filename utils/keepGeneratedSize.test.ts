import { describe, it, expect } from 'vitest';
import { keepGeneratedSize } from './keepGeneratedSize.js';

/**
 * 260731 クライアント指摘「AI編集を繰り返すと画質が劣化（ボヤけ）する」。
 *
 * 原因のひとつが解像度のラチェット。生成は 2K（16:9 で長辺≒2688px）なのに、
 * 結果を毎回「いまの版の寸法」へ縮めて保存していたため、
 * 1K 時代の版や写真取込（長辺1536px）の版では
 * 「2688px で描き起こす → 1536px へ縮める」を編集のたびに往復していた。
 * 解像度は決して上がらず、生成的な拡大と縮小のロスだけが積み上がる。
 */
describe('生成結果を縮めずにベースへ合わせる', () => {
  it('生成の方が大きければ、その解像度を活かす（縮めない）', () => {
    // 写真取込 1536×864 の版に、2K 生成 2688×1512 が返ってきた場合
    const out = keepGeneratedSize({ w: 1536, h: 864 }, { w: 2688, h: 1512 });
    expect(out.w).toBe(2688);
    expect(out.h).toBe(1512);
  });

  it('ベースのアスペクト比は必ず保つ（引き伸ばさない）', () => {
    const base = { w: 1536, h: 864 };
    const out = keepGeneratedSize(base, { w: 2688, h: 2688 });
    expect(out.w / out.h).toBeCloseTo(base.w / base.h, 3);
  });

  it('生成結果からはみ出す寸法にはしない（拡大の捏造をしない）', () => {
    const out = keepGeneratedSize({ w: 1000, h: 1000 }, { w: 2688, h: 1512 });
    expect(out.w).toBeLessThanOrEqual(2688);
    expect(out.h).toBeLessThanOrEqual(1512);
  });

  it('生成の方が小さければ従来どおりベース寸法（引き伸ばして画質は増えない）', () => {
    const out = keepGeneratedSize({ w: 2688, h: 1512 }, { w: 1024, h: 576 });
    expect(out).toEqual({ w: 2688, h: 1512 });
  });

  it('同寸ならそのまま（無駄な再サンプルを増やさない）', () => {
    const out = keepGeneratedSize({ w: 2688, h: 1512 }, { w: 2688, h: 1512 });
    expect(out).toEqual({ w: 2688, h: 1512 });
  });

  it('編集を繰り返しても解像度が下がり続けない（ラチェットの解消）', () => {
    // 1536 の版から始め、毎回 2688 の生成が返る想定で5回まわす
    let size = { w: 1536, h: 864 };
    for (let i = 0; i < 5; i += 1) {
      size = keepGeneratedSize(size, { w: 2688, h: 1512 });
    }
    expect(size.w).toBeGreaterThanOrEqual(2688);
  });

  it('壊れた入力でも0や負の寸法を返さない', () => {
    for (const bad of [
      { base: { w: 0, h: 0 }, out: { w: 100, h: 100 } },
      { base: { w: 100, h: 100 }, out: { w: 0, h: 0 } },
      { base: { w: -5, h: -5 }, out: { w: 100, h: 100 } },
    ]) {
      const r = keepGeneratedSize(bad.base, bad.out);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });
});
