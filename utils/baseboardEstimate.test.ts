import { describe, it, expect } from 'vitest';
import { buildBaseboardRows, baseboardTotalCost } from './baseboardEstimate.js';

describe('buildBaseboardRows (260613: 巾木 = 壁延長 × m単価)', () => {
  it('aggregates wall lengths per product and computes cost', () => {
    const rows = buildBaseboardRows([
      { lengthM: 3, productId: 'p1', productName: 'クロスA', brand: 'X', unitPricePerM: 500 },
      { lengthM: 2, productId: 'p1', productName: 'クロスA', brand: 'X', unitPricePerM: 500 },
      { lengthM: 4, productId: 'p2', productName: 'クロスB', brand: 'Y', unitPricePerM: 800 },
    ]);
    expect(rows).toHaveLength(2);
    const p1 = rows.find((r) => r.productId === 'p1')!;
    expect(p1.lengthM).toBeCloseTo(5, 5);
    expect(p1.cost).toBe(2500); // 5m × 500
    const p2 = rows.find((r) => r.productId === 'p2')!;
    expect(p2.cost).toBe(3200); // 4m × 800
    expect(baseboardTotalCost(rows)).toBe(5700);
  });

  it('still emits a row when unit price is 0 (length visible, cost 0)', () => {
    const rows = buildBaseboardRows([
      { lengthM: 3, productId: 'p1', productName: 'クロスA', brand: 'X', unitPricePerM: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].lengthM).toBeCloseTo(3, 5);
    expect(rows[0].cost).toBe(0);
  });

  it('skips zero/negative-length segments', () => {
    const rows = buildBaseboardRows([
      { lengthM: 0, productId: 'p1', productName: 'A', brand: 'X', unitPricePerM: 500 },
      { lengthM: -2, productId: 'p2', productName: 'B', brand: 'Y', unitPricePerM: 500 },
    ]);
    expect(rows).toHaveLength(0);
    expect(baseboardTotalCost(rows)).toBe(0);
  });

  it('clamps non-finite/negative unit price to 0', () => {
    const rows = buildBaseboardRows([
      { lengthM: 3, productId: 'p1', productName: 'A', brand: 'X', unitPricePerM: NaN },
      { lengthM: 3, productId: 'p2', productName: 'B', brand: 'Y', unitPricePerM: -100 },
    ]);
    expect(rows.find((r) => r.productId === 'p1')!.cost).toBe(0);
    expect(rows.find((r) => r.productId === 'p2')!.cost).toBe(0);
  });
});
