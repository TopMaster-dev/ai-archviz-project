import { describe, it, expect } from 'vitest';
import { DEFAULT_CROP_RECT, clampRect, rectFromPoints } from './cropRegion.js';

/**
 * 260731 クライアント要望③「最初に出るクロップ範囲を、画面中央に少し小さめに」。
 *
 * 以前は画像全体（w=1,h=1）から始めていた。全体のままでは「部屋の風景」を照合しに行くのと
 * 同じで、個別の商品はまず特定できない。最初から絞られていれば、説明なしで使い方が伝わる。
 */
describe('クロップの初期範囲', () => {
  it('画像全体ではない（絞る道具だと分かる）', () => {
    expect(DEFAULT_CROP_RECT.w).toBeLessThan(1);
    expect(DEFAULT_CROP_RECT.h).toBeLessThan(1);
  });

  it('画面中央にある', () => {
    expect(DEFAULT_CROP_RECT.x + DEFAULT_CROP_RECT.w / 2).toBeCloseTo(0.5, 6);
    expect(DEFAULT_CROP_RECT.y + DEFAULT_CROP_RECT.h / 2).toBeCloseTo(0.5, 6);
  });

  it('「少し小さめ」であって極小ではない（掴んで広げ直す手間を増やさない）', () => {
    expect(DEFAULT_CROP_RECT.w).toBeGreaterThanOrEqual(0.35);
    expect(DEFAULT_CROP_RECT.h).toBeGreaterThanOrEqual(0.35);
  });

  it('画像の外へはみ出さない', () => {
    expect(DEFAULT_CROP_RECT.x).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CROP_RECT.y).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CROP_RECT.x + DEFAULT_CROP_RECT.w).toBeLessThanOrEqual(1);
    expect(DEFAULT_CROP_RECT.y + DEFAULT_CROP_RECT.h).toBeLessThanOrEqual(1);
  });

  it('そのまま clamp を通しても変わらない（初期値が既に正当）', () => {
    expect(clampRect(DEFAULT_CROP_RECT)).toEqual(DEFAULT_CROP_RECT);
  });

  it('ドラッグで作った矩形と同じ形式（相互に置き換えられる）', () => {
    const r = rectFromPoints(0.25, 0.25, 0.75, 0.75);
    expect(r.x).toBeCloseTo(DEFAULT_CROP_RECT.x, 6);
    expect(r.w).toBeCloseTo(DEFAULT_CROP_RECT.w, 6);
  });
});
