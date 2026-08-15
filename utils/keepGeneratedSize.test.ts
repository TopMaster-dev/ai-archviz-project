import { describe, it, expect } from 'vitest';
import { keepGeneratedSize } from './keepGeneratedSize.js';
import { AREA_EDIT_BASE_MAX_SIDE, PREVIEW_GEMINI_LONG_EDGE } from './printExportSpec.js';

/**
 * 260731 クライアント指摘「AI編集を繰り返すと画質が劣化（ボヤけ）する」／260814 手段1・2。
 *
 * 生成結果を毎回「いまの版の寸法」へリサンプルしていたのが1回あたりの損失（損失A）。
 * 版が生成より小さければ縮小、大きければ**拡大**され、どちらも編集のたびに積み上がる。
 * 手段1は「モデルが返した寸法のまま採用し、縦横比がずれた場合だけ補正する」。
 */
describe('手段1: 生成結果の寸法をそのまま採用する', () => {
  it('比が同じなら生成寸法がそのまま返る（リサイズが起きない）', () => {
    // これが手段1の核心。従来は base 寸法へ丸められていた。
    for (const [b, o] of [
      [{ w: 2688, h: 1512 }, { w: 2688, h: 1512 }], // 16:9 同寸
      [{ w: 2688, h: 2016 }, { w: 2048, h: 1536 }], // 4:3 で生成が小さい
      [{ w: 1536, h: 864 }, { w: 2688, h: 1512 }], // 16:9 で生成が大きい
    ] as const) {
      expect(keepGeneratedSize(b, o), `${b.w}x${b.h} ← ${o.w}x${o.h}`).toEqual({ w: o.w, h: o.h });
    }
  });

  it('生成がベースより小さくても拡大しない（旧実装はここで拡大していた）', () => {
    /*
      取込時に長辺を2688へ揃えた4:3写真（2688×2016）に、
      2K生成が2048×1536で返ってきた場合。
      旧実装は scale<=1 のクランプでベース寸法（2688×2016）へ**拡大**していた。
      補間で作った偽の画素を足したうえでぼかすことになり、損失が最も大きい経路だった。
    */
    const out = keepGeneratedSize({ w: 2688, h: 2016 }, { w: 2048, h: 1536 });
    expect(out).toEqual({ w: 2048, h: 1536 });
    expect(out.w).toBeLessThan(2688);
  });

  it('返る寸法は必ず生成結果の内側（拡大の捏造をしない）', () => {
    for (const [b, o] of [
      [{ w: 1000, h: 1000 }, { w: 2688, h: 1512 }],
      [{ w: 2688, h: 1512 }, { w: 1024, h: 576 }],
      [{ w: 2688, h: 2016 }, { w: 2048, h: 1536 }],
      [{ w: 1536, h: 864 }, { w: 2688, h: 2688 }],
    ] as const) {
      const out = keepGeneratedSize(b, o);
      expect(out.w, `${b.w}x${b.h} ← ${o.w}x${o.h}`).toBeLessThanOrEqual(o.w);
      expect(out.h, `${b.w}x${b.h} ← ${o.w}x${o.h}`).toBeLessThanOrEqual(o.h);
    }
  });

  it('ベースのアスペクト比は必ず保つ（構図を変えない）', () => {
    // クライアントが明確に拒否した「構図が変わる処理」に該当しないことの担保。
    for (const [b, o] of [
      [{ w: 1536, h: 864 }, { w: 2688, h: 2688 }],
      [{ w: 2688, h: 2016 }, { w: 2688, h: 1512 }],
      [{ w: 1080, h: 1920 }, { w: 2688, h: 1512 }],
    ] as const) {
      const out = keepGeneratedSize(b, o);
      expect(out.w / out.h, `${b.w}x${b.h} ← ${o.w}x${o.h}`).toBeCloseTo(b.w / b.h, 2);
    }
  });

  it('繰り返しても寸法が振動せず落ち着く（毎回同じ生成寸法が返る想定）', () => {
    let size = { w: 1536, h: 864 };
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      size = keepGeneratedSize(size, { w: 2688, h: 1512 });
      seen.push(`${size.w}x${size.h}`);
    }
    // 1回目で生成寸法へ移り、以後は同じ寸法のまま（＝リサンプルが起きない）。
    expect(seen).toEqual(['2688x1512', '2688x1512', '2688x1512', '2688x1512', '2688x1512']);
  });

  it('壊れた入力でも0や負の寸法を返さない', () => {
    for (const bad of [
      { base: { w: 0, h: 0 }, out: { w: 100, h: 100 } },
      { base: { w: 100, h: 100 }, out: { w: 0, h: 0 } },
      { base: { w: -5, h: -5 }, out: { w: 100, h: 100 } },
      { base: { w: NaN, h: 100 }, out: { w: 100, h: 100 } },
      { base: { w: 100, h: 100 }, out: { w: NaN, h: 100 } },
    ]) {
      const r = keepGeneratedSize(bad.base, bad.out);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(Number.isFinite(r.w)).toBe(true);
      expect(Number.isFinite(r.h)).toBe(true);
    }
  });
});

describe('手段2: 土台の上限が生成長辺と一致している', () => {
  it('AREA_EDIT_BASE_MAX_SIDE が生成長辺と同じ', () => {
    /*
      土台が生成結果より大きくなり得ると、そのぶん必ず拡大リサイズが入る。
      上限を生成長辺に一致させることで、リサイズが原理的に発生しなくなる。
      旧値は3072で、2688の生成に対し常に上振れする余地があった。
    */
    expect(AREA_EDIT_BASE_MAX_SIDE).toBe(PREVIEW_GEMINI_LONG_EDGE);
  });

  it('2K/1K の切替に追従する（片方だけ取り残されない）', () => {
    expect([2688, 1344]).toContain(AREA_EDIT_BASE_MAX_SIDE);
  });
});
