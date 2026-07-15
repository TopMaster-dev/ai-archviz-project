import { describe, it, expect } from 'vitest';
import { buildBaseboardRows, baseboardTotalCost, baseboardSegmentLengthM } from './baseboardEstimate.js';

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

describe('baseboardSegmentLengthM (260715 #8: 開口で途切れた分を除外)', () => {
  const bbH = 60; // 巾木高さ 60mm

  it('returns full length in meters when there are no openings', () => {
    expect(baseboardSegmentLengthM(4000, [], bbH)).toBeCloseTo(4, 5);
  });

  it('subtracts a floor-reaching door width plus its frame (2×40mm)', () => {
    // ドア: width 800 + 枠 80 = 880mm を差し引く → (4000-880)/1000 = 3.12m
    const len = baseboardSegmentLengthM(4000, [
      { type: 'door_single', width: 800, bottomOffset: 0 },
    ], bbH);
    expect(len).toBeCloseTo(3.12, 5);
  });

  it('does NOT subtract an elevated window (sill above the baseboard band)', () => {
    // 腰高窓（bottomOffset 800 > 巾木上端 60）→ 巾木の下を通るので差し引かない。
    const len = baseboardSegmentLengthM(4000, [
      { type: 'window_fix', width: 1200, bottomOffset: 800 },
    ], bbH);
    expect(len).toBeCloseTo(4, 5);
  });

  it('subtracts a floor-to-floor sliding window (bottomOffset 0)', () => {
    // 掃き出し窓（床から）: 窓は枠加算なし → width 1600 をそのまま差し引く。
    const len = baseboardSegmentLengthM(4000, [
      { type: 'window_sliding', width: 1600, bottomOffset: 0 },
    ], bbH);
    expect(len).toBeCloseTo(2.4, 5);
  });

  it('clamps to 0 when openings exceed the wall length', () => {
    const len = baseboardSegmentLengthM(1000, [
      { type: 'door_single', width: 900, bottomOffset: 0 },
      { type: 'door_sliding', width: 900, bottomOffset: 0 },
    ], bbH);
    expect(len).toBe(0);
  });

  it('uses the baseboard height as the interruption threshold (window bottom just under top counts)', () => {
    // bottomOffset 59 < 巾木高 60 → 差し引く。
    const subtracted = baseboardSegmentLengthM(3000, [
      { type: 'window_casement', width: 1000, bottomOffset: 59 },
    ], bbH);
    expect(subtracted).toBeCloseTo(2, 5);
    // bottomOffset 60 は帯の上端と同じ＝途切れないので差し引かない。
    const kept = baseboardSegmentLengthM(3000, [
      { type: 'window_casement', width: 1000, bottomOffset: 60 },
    ], bbH);
    expect(kept).toBeCloseTo(3, 5);
  });
});
