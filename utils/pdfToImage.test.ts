import { describe, it, expect } from 'vitest';
import { fitRasterScale } from './pdfToImage.js';

/**
 * 260728 クライアント #4:「PDFを選ぶと『下絵の読み込みに失敗しました』」対策。
 * A1/A0 の図面を固定 scale=2 で焼くとキャンバスが巨大化し、描画/画像化の失敗や
 * 数十MBの base64（プロジェクトへ保存される）を招くため、上限内へ自動で切り下げる。
 */
describe('fitRasterScale', () => {
  const A4 = { w: 595, h: 842 };
  const A1 = { w: 1684, h: 2384 };
  const A0 = { w: 2384, h: 3370 };

  const sideOf = (p: { w: number; h: number }, s: number) => Math.max(p.w * s, p.h * s);
  const areaOf = (p: { w: number; h: number }, s: number) => p.w * s * (p.h * s);

  it('A4 は希望スケールをそのまま使える（切り下げ不要）', () => {
    expect(fitRasterScale(A4.w, A4.h, 2)).toBe(2);
  });

  it('A1 は上限内へ切り下げる', () => {
    const s = fitRasterScale(A1.w, A1.h, 2);
    expect(s).toBeLessThan(2);
    expect(sideOf(A1, s)).toBeLessThanOrEqual(4096 + 1e-6);
    expect(areaOf(A1, s)).toBeLessThanOrEqual(12_000_000 + 1);
  });

  it('A0 も上限内へ収まる', () => {
    const s = fitRasterScale(A0.w, A0.h, 2);
    expect(sideOf(A0, s)).toBeLessThanOrEqual(4096 + 1e-6);
    expect(areaOf(A0, s)).toBeLessThanOrEqual(12_000_000 + 1);
  });

  it('希望スケールより大きくはしない（拡大はしない）', () => {
    expect(fitRasterScale(A4.w, A4.h, 1)).toBe(1);
    expect(fitRasterScale(100, 100, 0.5)).toBe(0.5);
  });

  it('極端に大きな MediaBox でも上限を超えない（下限が上限に勝たない）', () => {
    // pdfjs は PDF仕様の 14400 単位上限を強制しないため、異常に大きなページが来うる。
    // 下限クランプを上限の外側に置くと、ここで巨大キャンバスに戻ってしまう。
    const s = fitRasterScale(100000, 100000, 2);
    expect(100000 * s).toBeLessThanOrEqual(4096 + 1e-6);
    expect(100000 * s * (100000 * s)).toBeLessThanOrEqual(12_000_000 + 1);
  });

  it('不正な入力は 1 にフォールバックする', () => {
    expect(fitRasterScale(0, 800, 2)).toBe(1);
    expect(fitRasterScale(600, Number.NaN, 2)).toBe(1);
    expect(fitRasterScale(600, 800, 0)).toBe(1);
  });
});
