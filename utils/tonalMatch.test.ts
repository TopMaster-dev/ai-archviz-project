import { describe, it, expect } from 'vitest';
import { computeRingGains, applyGainInMask } from './tonalMatch.js';

// RGBA バッファを作るヘルパ（全画素同一色）。
function solid(pxCount: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(pxCount * 4);
  for (let i = 0; i < pxCount; i += 1) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}
// 先頭 n 画素だけアルファを立てたマスク/リング（RGBA・アルファ以外は白）。
function alphaFirst(pxCount: number, n: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(pxCount * 4);
  for (let i = 0; i < pxCount; i += 1) {
    buf[i * 4] = 255;
    buf[i * 4 + 1] = 255;
    buf[i * 4 + 2] = 255;
    buf[i * 4 + 3] = i < n ? 255 : 0;
  }
  return buf;
}

describe('computeRingGains（境界リングのゲイン算出・260706）', () => {
  it('明るすぎる編集はベース明るさへ寄せるゲイン（<1）を返す', () => {
    const px = 1000;
    const base = solid(px, 128, 128, 128);
    const edit = solid(px, 160, 160, 160); // +25% 明るい
    const ring = alphaFirst(px, 500); // 十分なリング画素
    const res = computeRingGains(base, edit, ring, px);
    expect(res.applied).toBe(true);
    expect(res.gain[0]).toBeCloseTo(128 / 160, 2); // 0.8
    // 適用後のリング内画素はベースに一致する
    expect(160 * res.gain[0]).toBeCloseTo(128, 0);
  });

  it('リング画素が少ないと無補正（applied=false・ゲイン1）', () => {
    const px = 1000;
    const base = solid(px, 128, 128, 128);
    const edit = solid(px, 200, 200, 200);
    const ring = alphaFirst(px, 50); // minRingPixels(200) 未満
    const res = computeRingGains(base, edit, ring, px);
    expect(res.applied).toBe(false);
    expect(res.gain).toEqual([1, 1, 1]);
  });

  it('極端な比はゲインを [1/1.6, 1.6] にクランプ（反転・破綻しない）', () => {
    const px = 1000;
    const ring = alphaFirst(px, 500);
    // 暗いベース/明るい編集 → 0.05 になるはずだがクランプで 0.625
    const dark = computeRingGains(solid(px, 10, 10, 10), solid(px, 200, 200, 200), ring, px);
    expect(dark.gain[0]).toBeCloseTo(1 / 1.6, 3);
    // 明るいベース/暗い編集 → クランプ上限 1.6
    const bright = computeRingGains(solid(px, 200, 200, 200), solid(px, 10, 10, 10), ring, px);
    expect(bright.gain[0]).toBeCloseTo(1.6, 3);
  });

  it('edit 平均が0近傍のチャンネルは無補正（割り算不安定回避）', () => {
    const px = 1000;
    const base = solid(px, 128, 128, 128);
    const edit = solid(px, 0, 0, 0);
    const ring = alphaFirst(px, 500);
    const res = computeRingGains(base, edit, ring, px);
    expect(res.applied).toBe(false);
  });

  it('リングがマスクのほぼ全域（erode コア空＝退化）なら無補正（意図した領域内変更を打ち消さない）', () => {
    const px = 1000;
    const base = solid(px, 120, 120, 120);
    const edit = solid(px, 180, 180, 180); // 領域内を明るく編集
    const ring = alphaFirst(px, 500); // リング=500画素
    // maskCount=500（リング==マスク＝コア空）→ 退化ガードで無補正
    const degenerate = computeRingGains(base, edit, ring, px, { maskCount: 500 });
    expect(degenerate.applied).toBe(false);
    // 参考: maskCount が十分大きい（リングはマスクの一部＝正常）なら補正される
    const normal = computeRingGains(base, edit, ring, px, { maskCount: 5000 });
    expect(normal.applied).toBe(true);
    expect(normal.gain[0]).toBeCloseTo(120 / 180, 2);
  });
});

describe('applyGainInMask（マスク内のみゲイン適用・マスク外は不変）', () => {
  it('マスク内はゲイン適用、マスク外はバイト不変', () => {
    const px = 100;
    const edit = solid(px, 160, 160, 160);
    const mask = alphaFirst(px, 40); // 先頭40画素がマスク内
    applyGainInMask(edit, mask, [0.8, 0.8, 0.8], px);
    // マスク内（i=0）: 160*0.8=128
    expect(edit[0]).toBe(128);
    // マスク外（i=50）: 不変 160
    expect(edit[50 * 4]).toBe(160);
  });

  it('ゲイン=[1,1,1] は何もしない（早期 return）', () => {
    const px = 10;
    const edit = solid(px, 123, 45, 67);
    const before = Array.from(edit);
    applyGainInMask(edit, alphaFirst(px, 10), [1, 1, 1], px);
    expect(Array.from(edit)).toEqual(before);
  });

  it('255 を超える値は 255 にクランプ', () => {
    const px = 10;
    const edit = solid(px, 200, 200, 200);
    applyGainInMask(edit, alphaFirst(px, 10), [1.6, 1.6, 1.6], px);
    expect(edit[0]).toBe(255); // 200*1.6=320 → 255
  });
});
