import { describe, it, expect } from 'vitest';
import { unsharpMaskImageData, unsharpParamsForUpscale } from './unsharpMask.js';

/**
 * 260801 クライアント指摘「高解像度（AIなし）は、低解像度の画像を無理やり引き伸ばして
 * 4Kと言っているだけではないか。ボヤけたハリボテでは実務で使えない」。
 *
 * ご指摘は正しく、補間で拡大するだけでは輪郭は甘いままになる。
 * そこで拡大後に決定論の鮮鋭化（アンシャープマスク）を掛ける。
 * この処理の要件は2つ:
 *  ① 輪郭のコントラストが実際に上がること（＝ボヤけが改善すること）
 *  ② 元画像に無いものを絶対に作らないこと（AI精細化で木目が生えた問題を再発させない）
 */

/** 幅 w・高さ h の灰色画像に、左半分だけ暗い縦のエッジを作る。 */
function edgeImage(w: number, h: number, left = 100, right = 160): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = x < w / 2 ? left : right;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  return d;
}

const at = (d: Uint8ClampedArray, w: number, x: number, y: number) => d[(y * w + x) * 4];

describe('輪郭が締まること', () => {
  it('エッジの両側のコントラストが処理前より大きくなる', () => {
    const w = 32;
    const h = 8;
    const before = edgeImage(w, h);
    const after = new Uint8ClampedArray(before);
    unsharpMaskImageData(after, w, h, { radius: 2, amount: 0.8, threshold: 0 });

    const mid = w / 2;
    const contrastBefore = at(before, w, mid, 4) - at(before, w, mid - 1, 4);
    const contrastAfter = at(after, w, mid, 4) - at(after, w, mid - 1, 4);
    expect(contrastAfter).toBeGreaterThan(contrastBefore);
  });

  it('強さ0では何も変わらない', () => {
    const w = 16;
    const h = 8;
    const d = edgeImage(w, h);
    const copy = new Uint8ClampedArray(d);
    unsharpMaskImageData(d, w, h, { amount: 0 });
    expect(Array.from(d)).toEqual(Array.from(copy));
  });
});

describe('元画像に無いものを作らないこと', () => {
  it('完全に均一な面には何も描かれない（模様が生えない）', () => {
    const w = 24;
    const h = 24;
    const flat = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < flat.length; i += 4) {
      flat[i] = 200;
      flat[i + 1] = 200;
      flat[i + 2] = 200;
      flat[i + 3] = 255;
    }
    const after = new Uint8ClampedArray(flat);
    unsharpMaskImageData(after, w, h, { radius: 2, amount: 0.8, threshold: 0 });
    // 白い天板のような無地の面は無地のまま（AI精細化で木目が生えた問題の再発防止）
    expect(Array.from(after)).toEqual(Array.from(flat));
  });

  it('しきい値未満の微小な差（ノイズ）は持ち上げない', () => {
    const w = 16;
    const h = 8;
    const faint = edgeImage(w, h, 128, 130); // 差2のごく弱い模様
    const after = new Uint8ClampedArray(faint);
    unsharpMaskImageData(after, w, h, { radius: 2, amount: 1.0, threshold: 5 });
    expect(Array.from(after)).toEqual(Array.from(faint));
  });

  it('アルファ（透過）は変更しない', () => {
    const w = 16;
    const h = 8;
    const d = edgeImage(w, h);
    for (let i = 3; i < d.length; i += 4) d[i] = 128;
    unsharpMaskImageData(d, w, h, { radius: 2, amount: 0.8, threshold: 0 });
    for (let i = 3; i < d.length; i += 4) expect(d[i]).toBe(128);
  });

  it('画素値は 0〜255 に収まる（白飛び・黒潰れで破綻しない）', () => {
    const w = 16;
    const h = 8;
    const d = edgeImage(w, h, 0, 255); // 最大コントラスト
    unsharpMaskImageData(d, w, h, { radius: 2, amount: 2.0, threshold: 0 });
    for (const v of d) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of d) expect(v).toBeLessThanOrEqual(255);
  });

  it('極小の画像でも落ちない', () => {
    for (const [w, h] of [
      [1, 1],
      [2, 2],
      [3, 1],
    ]) {
      const d = new Uint8ClampedArray(w * h * 4);
      expect(() => unsharpMaskImageData(d, w, h, { radius: 2, amount: 0.8 })).not.toThrow();
    }
  });
});

describe('拡大率に応じた強さ', () => {
  it('拡大していないときは鮮鋭化しない（勝手に加工しない）', () => {
    expect(unsharpParamsForUpscale(1)).toBeNull();
    expect(unsharpParamsForUpscale(0.5)).toBeNull();
  });

  it('拡大率が大きいほど強くなる', () => {
    const a = unsharpParamsForUpscale(1.3)!;
    const b = unsharpParamsForUpscale(1.85)!;
    expect(b.amount!).toBeGreaterThan(a.amount!);
    expect(b.radius!).toBeGreaterThan(a.radius!);
  });

  it('強くしすぎない（輪郭の白フチを防ぐ上限がある）', () => {
    const extreme = unsharpParamsForUpscale(10)!;
    expect(extreme.amount!).toBeLessThanOrEqual(0.85);
    expect(extreme.radius!).toBeLessThanOrEqual(2.4);
  });

  it('実際の書き出し倍率（2688px → A3 300dpi 4961px ＝ 約1.85倍）で有効', () => {
    const p = unsharpParamsForUpscale(4961 / 2688);
    expect(p).not.toBeNull();
    expect(p!.amount!).toBeGreaterThan(0);
  });

  it('壊れた値は鮮鋭化しない（勝手な加工をしない側へ倒す）', () => {
    // 元画像の寸法が取れないと倍率が NaN / Infinity になる。
    // その状態で強さを決め打ちするより、何もせず素通しする方が安全。
    for (const bad of [NaN, Infinity, -Infinity, 0]) {
      expect(unsharpParamsForUpscale(bad), String(bad)).toBeNull();
    }
  });
});
