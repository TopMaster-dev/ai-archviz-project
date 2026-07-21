import { describe, it, expect } from 'vitest';
import { pullPushInterpolate, applyMembraneOffset } from './seamlessBlend.js';

describe('pullPushInterpolate (調和膜の pull-push 近似)', () => {
  it('全画素が既知ならそのまま返す（既知値は不変）', () => {
    const w = 8;
    const h = 8;
    const value = new Float32Array(w * h).fill(50);
    const weight = new Float32Array(w * h).fill(1);
    const out = pullPushInterpolate(value, weight, w, h);
    for (let i = 0; i < w * h; i += 1) expect(out[i]).toBeCloseTo(50, 3);
  });

  it('一定の境界値は内部も一定に埋まる（定数は調和）', () => {
    const w = 16;
    const h = 16;
    const value = new Float32Array(w * h);
    const weight = new Float32Array(w * h);
    // 外周1px を既知=30、内部は未知。
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          value[y * w + x] = 30;
          weight[y * w + x] = 1;
        }
      }
    }
    const out = pullPushInterpolate(value, weight, w, h);
    // 中心付近が ~30 に埋まる。
    expect(out[8 * w + 8]).toBeCloseTo(30, 0);
    expect(out[4 * w + 4]).toBeCloseTo(30, 0);
  });

  it('左端0・右端100の1D境界は単調増加のランプに補間される', () => {
    const w = 8;
    const h = 1;
    const value = new Float32Array(w);
    const weight = new Float32Array(w);
    value[0] = 0;
    weight[0] = 1;
    value[w - 1] = 100;
    weight[w - 1] = 1;
    const out = pullPushInterpolate(value, weight, w, h);
    expect(out[0]).toBeCloseTo(0, 3); // 既知端は保持
    expect(out[w - 1]).toBeCloseTo(100, 3);
    // 単調増加（左→右）。
    for (let x = 1; x < w; x += 1) expect(out[x]).toBeGreaterThanOrEqual(out[x - 1] - 1e-3);
    // 中央付近は 0 と 100 の間。
    expect(out[w >> 1]).toBeGreaterThan(20);
    expect(out[w >> 1]).toBeLessThan(80);
  });

  it('既知が皆無（重み0）なら全0のまま', () => {
    const w = 4;
    const h = 4;
    const value = new Float32Array(w * h).fill(7); // 値はあるが weight=0 なので無効
    const weight = new Float32Array(w * h); // すべて0
    const out = pullPushInterpolate(value, weight, w, h);
    for (let i = 0; i < w * h; i += 1) expect(out[i]).toBeCloseTo(0, 3);
  });
});

// RGBA 平面を組む小ヘルパ。
function rgbaFilled(px: number, v: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(px * 4);
  for (let i = 0; i < px; i += 1) {
    a[i * 4] = v;
    a[i * 4 + 1] = v;
    a[i * 4 + 2] = v;
    a[i * 4 + 3] = 255;
  }
  return a;
}
function alphaMask(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      a[(y * w + x) * 4 + 3] = inside(x, y) ? 255 : 0;
    }
  }
  return a;
}

describe('applyMembraneOffset (境界差分を内側へ流して継ぎ目を消す)', () => {
  const w = 24;
  const h = 24;
  const px = w * h;
  // 中央 16x16 の正方形 [4..19]x[4..19] を Ω（適用領域）、その内縁2px を境界リングとする。
  const inSquare = (x: number, y: number) => x >= 4 && x <= 19 && y >= 4 && y <= 19;
  const inRing = (x: number, y: number) =>
    inSquare(x, y) && (x <= 5 || x >= 18 || y <= 5 || y >= 18);

  it('一定の露出差(base-edit=50)を打ち消し、Ω内で edit≈base になる（継ぎ目消失）', () => {
    const base = rgbaFilled(px, 150);
    const edit = rgbaFilled(px, 100); // Ω内外とも100（Ω外は不変であるべき）
    const ring = alphaMask(w, h, inRing);
    const apply = alphaMask(w, h, inSquare);
    const ok = applyMembraneOffset(base, edit, ring, apply, w, h);
    expect(ok).toBe(true);
    // Ω 中心は base(150) に近づく（差分50を埋めた）。
    const ci = (12 * w + 12) * 4;
    expect(edit[ci]).toBeGreaterThan(140);
    expect(edit[ci]).toBeLessThanOrEqual(150);
    // Ω 外（マスク alpha=0）は不変=100。
    const oi = (0 * w + 0) * 4;
    expect(edit[oi]).toBe(100);
  });

  it('リング画素が少なすぎると false（呼び出し側でフォールバック）', () => {
    const base = rgbaFilled(px, 150);
    const edit = rgbaFilled(px, 100);
    // ごく小さいリング（1画素）＝ minRingPixels 未満。
    const ring = alphaMask(w, h, (x, y) => x === 4 && y === 4);
    const apply = alphaMask(w, h, inSquare);
    const ok = applyMembraneOffset(base, edit, ring, apply, w, h);
    expect(ok).toBe(false);
    // 何も変えない。
    expect(edit[(12 * w + 12) * 4]).toBe(100);
  });

  it('リングがマスクのほぼ全域なら false（退化ガード＝編集を消さない）', () => {
    const base = rgbaFilled(px, 150);
    const edit = rgbaFilled(px, 100);
    // ring と apply をほぼ同一（=コアが空）にする。
    const ring = alphaMask(w, h, inSquare);
    const apply = alphaMask(w, h, inSquare);
    const ok = applyMembraneOffset(base, edit, ring, apply, w, h);
    expect(ok).toBe(false);
    expect(edit[(12 * w + 12) * 4]).toBe(100); // 何も変えない
  });

  it('オフセットは maxOffset にクランプされる（暴発しない）', () => {
    const base = rgbaFilled(px, 255);
    const edit = rgbaFilled(px, 0); // 差分255だが maxOffset=10 に制限
    const ring = alphaMask(w, h, inRing);
    const apply = alphaMask(w, h, inSquare);
    const ok = applyMembraneOffset(base, edit, ring, apply, w, h, { maxOffset: 10 });
    expect(ok).toBe(true);
    // 中心は 0 + (<=10) に収まる。
    expect(edit[(12 * w + 12) * 4]).toBeLessThanOrEqual(10);
  });
});
