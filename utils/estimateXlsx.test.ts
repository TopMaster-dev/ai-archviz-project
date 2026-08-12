import { describe, it, expect } from 'vitest';
import { fitImageBox, pxToColWidth, splitRowHeights, ESTIMATE_COLUMN_WIDTHS, BOARD_COLUMN_WIDTHS } from './estimateXlsx.js';

/**
 * Excel から PDF に書き出したときのレイアウト崩れ対策（260813 クライアント指摘）。
 *
 * Excel は「1ページ幅に収める」設定のとき、内容が印刷可能幅を超えると
 * ページ全体を縮小して収める。文字も画像も一緒に小さくなる。
 * したがって「列幅の合計が用紙に収まっているか」が、そのまま
 * 「Ariseで出したPDFと同じ大きさで刷れるか」になる。
 *
 * ここは崩れの原因そのものを数値で固定するテスト。
 */

/** Excel の列幅単位 → px（既定フォントで px ≒ 幅×7+5）。 */
const colsToPx = (units: readonly number[]) => units.reduce((s, u) => s + (u * 7 + 5), 0);

/** 用紙の印刷可能幅（px・96dpi）。余白は上下左右10mm。 */
const printableW = (paperMm: number) => Math.round(((paperMm - 20) / 25.4) * 96);

const A4_PORTRAIT_W = printableW(210); // ≒718
const A3_LANDSCAPE_W = printableW(420); // ≒1512

describe('列幅が用紙に収まっている（縮小されずに刷れる）', () => {
  it('見積表は A4縦の印刷可能幅に収まる', () => {
    const px = colsToPx(ESTIMATE_COLUMN_WIDTHS);
    expect(px).toBeLessThanOrEqual(A4_PORTRAIT_W);
    // 旧値（合計152＝1104px）は縮小率0.65まで潰れていた。等倍に近いことを担保する。
    expect(A4_PORTRAIT_W / px).toBeGreaterThan(0.95);
  });

  it('マテリアルボードは A3横の印刷可能幅に収まる', () => {
    const px = colsToPx(BOARD_COLUMN_WIDTHS);
    expect(px).toBeLessThanOrEqual(A3_LANDSCAPE_W);
  });

  it('マテリアルボードは用紙の幅を使い切る', () => {
    // 旧値は963px＝A3横の64%しか使わず、右側に大きな余白が残っていた。
    const px = colsToPx(BOARD_COLUMN_WIDTHS);
    expect(px / A3_LANDSCAPE_W).toBeGreaterThan(0.9);
  });
});

describe('画像は用紙の中に収まる（幅だけでなく高さも）', () => {
  const BOX_W = 1452;
  const BOX_H = 957;

  it('横長は幅で決まる', () => {
    const { w, h } = fitImageBox(16 / 9, BOX_W, BOX_H);
    expect(w).toBe(BOX_W);
    expect(h).toBeLessThanOrEqual(BOX_H);
  });

  it('縦長は高さで決まる（旧実装はここで用紙をはみ出していた）', () => {
    // 旧実装は幅を900pxに固定し高さを比率なりに伸ばしていたため、
    // 3:4 だと高さ1200px＝印刷可能領域超え。「1ページに収める」でページごと縮小されていた。
    const { w, h } = fitImageBox(3 / 4, BOX_W, BOX_H);
    expect(h).toBe(BOX_H);
    expect(w).toBeLessThanOrEqual(BOX_W);
  });

  it('どの比率でも用紙からはみ出さない', () => {
    for (const r of [16 / 9, 4 / 3, 1, 3 / 4, 9 / 16, 2.35]) {
      const { w, h } = fitImageBox(r, BOX_W, BOX_H);
      expect(w, `ratio ${r}`).toBeLessThanOrEqual(BOX_W);
      expect(h, `ratio ${r}`).toBeLessThanOrEqual(BOX_H);
    }
  });

  it('縦横比は保つ（画像が歪んではいけない）', () => {
    for (const r of [16 / 9, 4 / 3, 3 / 4, 9 / 16]) {
      const { w, h } = fitImageBox(r, BOX_W, BOX_H);
      expect(w / h, `ratio ${r}`).toBeCloseTo(r, 1);
    }
  });

  it('比率が取れないときは 16:9 とみなす（落とさない）', () => {
    for (const bad of [NaN, 0, -1, Infinity]) {
      const { w, h } = fitImageBox(bad, BOX_W, BOX_H);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });
});

describe('行の高さは Excel の上限（409pt）を超えない', () => {
  it('高い画像は複数行へ割り振る', () => {
    const heights = splitRowHeights(957);
    expect(heights.length).toBeGreaterThan(1);
    for (const h of heights) expect(h).toBeLessThanOrEqual(409);
  });

  it('割り振った合計は画像の高さと一致する（印刷範囲が画像より短くならない）', () => {
    for (const px of [100, 545, 816, 957, 2000]) {
      const heights = splitRowHeights(px);
      const sum = heights.reduce((a, b) => a + b, 0);
      expect(sum, `${px}px`).toBeCloseTo(px * 0.75 + 6, 6);
      for (const h of heights) expect(h, `${px}px`).toBeLessThanOrEqual(409);
    }
  });

  it('低い画像は1行のまま', () => {
    expect(splitRowHeights(200)).toHaveLength(1);
  });

  it('壊れた入力でも行は必ず1つ以上', () => {
    for (const bad of [0, -5, NaN]) {
      const heights = splitRowHeights(bad as number);
      expect(heights.length).toBeGreaterThanOrEqual(1);
      expect(heights[0]).toBeGreaterThan(0);
    }
  });
});

describe('px から列幅への換算', () => {
  it('換算して戻すと元の px に近い', () => {
    for (const px of [140, 500, 1000, 1452]) {
      const units = pxToColWidth(px);
      expect(units * 7 + 5, `${px}px`).toBeCloseTo(px, -1);
    }
  });

  it('Excel の上限（255）と下限（1）を超えない', () => {
    expect(pxToColWidth(99999)).toBeLessThanOrEqual(255);
    expect(pxToColWidth(0)).toBeGreaterThanOrEqual(1);
    expect(pxToColWidth(NaN)).toBeGreaterThanOrEqual(1);
  });
});
