import type { Opening } from '../types.js';

/**
 * 壁の縦方向セグメント [segmentBottomMm, segmentTopMm]（床からの mm）と重なる開口の面積（㎡）。
 * 幅 × 重なり高さで算定（壁面のブール穴と整合）。
 */
export function openingHoleAreaM2OnWallSegment(
  op: Opening,
  segmentBottomMm: number,
  segmentTopMm: number
): number {
  const opBottom = op.bottomOffset;
  const opTop = op.bottomOffset + op.height;
  const overlapMm = Math.max(0, Math.min(opTop, segmentTopMm) - Math.max(opBottom, segmentBottomMm));
  if (overlapMm <= 0) return 0;
  return (op.width * overlapMm) / 1_000_000;
}
