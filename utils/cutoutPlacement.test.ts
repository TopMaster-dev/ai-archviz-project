import { describe, it, expect } from 'vitest';
import { computeCutoutPlacement } from './cutoutPlacement.js';

const region = { x: 0.25, y: 0.3, w: 0.4, h: 0.5 }; // px: x100 y150 w160 h250 (base 400x500)
const baseW = 400;
const baseH = 500;

describe('computeCutoutPlacement（純関数・決定論配置）', () => {
  it('アスペクト比を保つ（出力の縦横比＝切り抜きの縦横比）', () => {
    const p = computeCutoutPlacement(300, 200, region, baseW, baseH, { fitFrac: 0.9 });
    expect(p.dw / p.dh).toBeCloseTo(300 / 200, 3);
  });

  it('幅は範囲幅×fitFrac', () => {
    const p = computeCutoutPlacement(200, 200, region, baseW, baseH, { fitFrac: 0.9, maxHeightFrac: 2 });
    expect(p.dw).toBeCloseTo(region.w * baseW * 0.9, 3); // 160*0.9=144
  });

  it('floor 接地: 商品の下端＝範囲下端−余白', () => {
    const p = computeCutoutPlacement(100, 300, region, baseW, baseH, {
      fitFrac: 0.5,
      anchor: 'floor',
      bottomInsetFrac: 0.02,
      maxHeightFrac: 5,
    });
    const regBottom = (region.y + region.h) * baseH; // 400
    const expectedBottom = regBottom - region.h * baseH * 0.02; // 400 - 5 = 395
    expect(p.dy + p.dh).toBeCloseTo(expectedBottom, 2);
  });

  it('center 接地: 範囲中央に配置', () => {
    const p = computeCutoutPlacement(100, 100, region, baseW, baseH, { fitFrac: 0.5, anchor: 'center' });
    const regCenterY = (region.y + region.h / 2) * baseH;
    expect(p.dy + p.dh / 2).toBeCloseTo(regCenterY, 1);
  });

  it('背の高い商品は範囲高さ(maxHeightFrac−下余白)で頭打ちし、幅も比例縮小・範囲の外へはみ出さない', () => {
    // 縦長 100x400、範囲 160x250、floor(既定)、bottomInset 0.02。fitFrac0.9→dw144,dh576。
    // 上限 = 250*1 − 250*0.02 = 245（下余白ぶんを差し引く）→ dh=245, dw=245*(100/400)=61.25。
    const p = computeCutoutPlacement(100, 400, region, baseW, baseH, { fitFrac: 0.9, maxHeightFrac: 1 });
    expect(p.dh).toBeCloseTo(245, 1);
    expect(p.dw).toBeCloseTo(61.25, 1);
    // 頭が範囲の上端より上へ出ない（最終クリップで頭が切れないこと）。
    const regTop = region.y * baseH;
    const regBottom = (region.y + region.h) * baseH;
    expect(p.dy).toBeGreaterThanOrEqual(regTop - 0.01);
    expect(p.dy + p.dh).toBeLessThanOrEqual(regBottom + 0.01);
  });

  it('範囲いっぱいの背高商品でも上端はみ出しゼロ（floor・回帰ガード）', () => {
    // どんなに縦長でも floor 接地で dy>=範囲上端。以前は下余白ぶん(2%)上へはみ出して頭が切れていた。
    for (const ch of [300, 500, 1000]) {
      const p = computeCutoutPlacement(100, ch, region, baseW, baseH, { fitFrac: 0.9, anchor: 'floor' });
      expect(p.dy).toBeGreaterThanOrEqual(region.y * baseH - 0.01);
      expect(p.dy + p.dh).toBeLessThanOrEqual((region.y + region.h) * baseH + 0.01);
    }
  });

  it('hAlign=0 は左寄せ、1 は右寄せ', () => {
    const left = computeCutoutPlacement(100, 100, region, baseW, baseH, { fitFrac: 0.5, hAlign: 0 });
    const right = computeCutoutPlacement(100, 100, region, baseW, baseH, { fitFrac: 0.5, hAlign: 1 });
    expect(left.dx).toBeCloseTo(region.x * baseW, 2);
    expect(right.dx).toBeCloseTo(region.x * baseW + region.w * baseW - right.dw, 2);
  });

  it('ベース画像内へクランプ（負や範囲外にならない・NaN無し）', () => {
    const p = computeCutoutPlacement(1000, 100, { x: 0.9, y: 0.9, w: 0.3, h: 0.3 }, baseW, baseH, { fitFrac: 1.5 });
    expect(p.dx).toBeGreaterThanOrEqual(0);
    expect(p.dy).toBeGreaterThanOrEqual(0);
    expect(p.dx + p.dw).toBeLessThanOrEqual(baseW + 0.5);
    expect(p.dy + p.dh).toBeLessThanOrEqual(baseH + 0.5);
    expect(Number.isNaN(p.dw)).toBe(false);
  });

  it('退化した範囲/切り抜きは安全に 0（NaN無し）', () => {
    const p = computeCutoutPlacement(0, 0, region, baseW, baseH);
    expect(p.dw).toBe(0);
    expect(Number.isNaN(p.dx)).toBe(false);
    const p2 = computeCutoutPlacement(100, 100, { x: 0.1, y: 0.1, w: 0, h: 0 }, baseW, baseH);
    expect(p2.dw).toBe(0);
  });
});
