import { describe, it, expect } from 'vitest';
import { keepGeneratedSize } from './keepGeneratedSize.js';
import {
  AREA_EDIT_BASE_MAX_SIDE,
  MEASURED_GEMINI_2K_LONG_EDGE,
  ENABLE_KEEP_GENERATED_SIZE,
} from './printExportSpec.js';

/**
 * 手段1（260814）とその巻き戻し（260818 フェーズ0）。
 *
 * 手段1 = 生成結果を版の寸法へリサイズせず、返ってきた寸法のまま採用する。
 * 実体は keepGeneratedSize の `scale <= 1` クランプの有無だけ。
 *
 * 260817 クライアント報告「構図が若干拡大される」を受け、導入前の状態へ完全に巻き戻して
 * 切り分ける方針になった。フラグは既定引数なので、両モードをここで直接検証する。
 */

describe('手段1 有効時（生成寸法をそのまま採用）', () => {
  const ON = true;

  it('比が同じなら生成寸法がそのまま返る（リサイズが起きない）', () => {
    for (const [b, o] of [
      [{ w: 2688, h: 1512 }, { w: 2688, h: 1512 }],
      [{ w: 2688, h: 2016 }, { w: 2048, h: 1536 }],
      [{ w: 1536, h: 864 }, { w: 2688, h: 1512 }],
    ] as const) {
      expect(keepGeneratedSize(b, o, ON), `${b.w}x${b.h} <- ${o.w}x${o.h}`).toEqual({ w: o.w, h: o.h });
    }
  });

  it('生成がベースより小さくても拡大しない', () => {
    expect(keepGeneratedSize({ w: 2688, h: 2016 }, { w: 2048, h: 1536 }, ON)).toEqual({ w: 2048, h: 1536 });
  });

  it('返る寸法は必ず生成結果の内側（拡大の捏造をしない）', () => {
    for (const [b, o] of [
      [{ w: 1000, h: 1000 }, { w: 2688, h: 1512 }],
      [{ w: 2688, h: 1512 }, { w: 1024, h: 576 }],
      [{ w: 1536, h: 864 }, { w: 2688, h: 2688 }],
    ] as const) {
      const out = keepGeneratedSize(b, o, ON);
      expect(out.w).toBeLessThanOrEqual(o.w);
      expect(out.h).toBeLessThanOrEqual(o.h);
    }
  });
});

describe('手段1 無効時（導入前の挙動）', () => {
  const OFF = false;

  it('生成がベースより小さければベース寸法（＝従来どおり拡大する）', () => {
    expect(keepGeneratedSize({ w: 2688, h: 2016 }, { w: 2048, h: 1536 }, OFF)).toEqual({ w: 2688, h: 2016 });
    expect(keepGeneratedSize({ w: 2688, h: 1512 }, { w: 1024, h: 576 }, OFF)).toEqual({ w: 2688, h: 1512 });
  });

  it('生成が大きいときは従来どおり引き上げる（ここは手段1と同じ）', () => {
    expect(keepGeneratedSize({ w: 1536, h: 864 }, { w: 2688, h: 1512 }, OFF)).toEqual({ w: 2688, h: 1512 });
  });

  it('同寸ならそのまま', () => {
    expect(keepGeneratedSize({ w: 2688, h: 1512 }, { w: 2688, h: 1512 }, OFF)).toEqual({ w: 2688, h: 1512 });
  });
});

describe('モードによらず成り立つこと', () => {
  it('ベースのアスペクト比は必ず保つ（構図を変えない）', () => {
    for (const mode of [true, false]) {
      for (const [b, o] of [
        [{ w: 1536, h: 864 }, { w: 2688, h: 2688 }],
        [{ w: 2688, h: 2016 }, { w: 2688, h: 1512 }],
        [{ w: 1080, h: 1920 }, { w: 2688, h: 1512 }],
      ] as const) {
        const out = keepGeneratedSize(b, o, mode);
        expect(out.w / out.h, `mode=${mode} ${b.w}x${b.h}`).toBeCloseTo(b.w / b.h, 2);
      }
    }
  });

  it('壊れた入力でも0や負の寸法を返さない', () => {
    for (const mode of [true, false]) {
      for (const bad of [
        { base: { w: 0, h: 0 }, out: { w: 100, h: 100 } },
        { base: { w: 100, h: 100 }, out: { w: 0, h: 0 } },
        { base: { w: NaN, h: 100 }, out: { w: 100, h: 100 } },
        { base: { w: 100, h: 100 }, out: { w: NaN, h: 100 } },
      ]) {
        const r = keepGeneratedSize(bad.base, bad.out, mode);
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
        expect(Number.isFinite(r.w)).toBe(true);
        expect(Number.isFinite(r.h)).toBe(true);
      }
    }
  });
});

describe('土台の上限は実測の生成長辺を下回ってはいけない', () => {
  /*
    260818 の最重要の不変条件。

    手段2 で上限を 2688 にしたが、実測の生成長辺は 2752 だった。
    上限のほうが小さいと、モデルへ渡す画像（2688へ縮小）と要求する出力（2752）の
    解像度が食い違う。モデルは入力と違う解像度を求められると忠実に写し取らず描き直しやすく、
    それが「構図が若干拡大される」というご指摘の想定原因。

    ここが赤くなったら、まず AREA_EDIT_BASE_MAX_SIDE を疑うこと。
  */
  it('AREA_EDIT_BASE_MAX_SIDE >= MEASURED_GEMINI_2K_LONG_EDGE', () => {
    expect(AREA_EDIT_BASE_MAX_SIDE).toBeGreaterThanOrEqual(MEASURED_GEMINI_2K_LONG_EDGE);
  });

  it('実測値は 2752（クライアント実ファイル2件で確認）', () => {
    expect(MEASURED_GEMINI_2K_LONG_EDGE).toBe(2752);
  });
});

describe('フェーズ0 の巻き戻し状態', () => {
  it('手段1 は無効（導入前の状態で切り分ける）', () => {
    // 切り分けが終わり再導入するときは、この期待値を true へ変えること。
    expect(ENABLE_KEEP_GENERATED_SIZE).toBe(false);
  });
});
