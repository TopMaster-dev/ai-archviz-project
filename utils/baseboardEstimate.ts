/**
 * 巾木（baseboard）見積ラインの集計。
 *
 * クライアント要望（260613 / 管理表 row 238）:「壁延長距離からの巾木計算」。
 * 巾木が有効な壁の延長距離（m）を製品ごとに合計し、m 単価（円/m）を掛けて金額を出す。
 * 面積ベースの建材ラインとは単位（m）が異なるため、別ラインとして扱う。
 */

import { getEffectiveOpeningWidthMm } from './sketchTransform.js';
import type { Opening } from '../types.js';

/**
 * 壁セグメントの巾木延長（m）を、床に達する開口（ドア・掃き出し窓など）の幅を差し引いて算定する
 * （260715 クライアント #8:「ドア/窓で途切れた分を除外」）。
 *
 * 巾木は床〜baseboardHeightMm の帯。開口の下端がこの帯より下にある（＝床に達する）場合のみ巾木が途切れると
 * みなし、その開口の有効幅（ドアは枠込み）を差し引く。掃き出し窓（bottomOffset=0）は差し引くが、腰高の一般的な
 * 窓（sill が巾木上端より高い）は巾木の下を通るため差し引かない＝物理的に正しい。
 * 合計ギャップが壁長を超えた場合は 0 にクランプ。
 */
export function baseboardSegmentLengthM(
  fullLengthMm: number,
  openingsOnWall: Pick<Opening, 'type' | 'width' | 'bottomOffset'>[],
  baseboardHeightMm: number
): number {
  let gapMm = 0;
  for (const op of openingsOnWall) {
    if (op.bottomOffset < baseboardHeightMm) {
      gapMm += getEffectiveOpeningWidthMm(op);
    }
  }
  return Math.max(0, (fullLengthMm - gapMm) / 1000);
}

export interface BaseboardWallSegment {
  /** 壁の延長（m） */
  lengthM: number;
  productId: string;
  productName: string;
  brand: string;
  /** 巾木の m 単価（円/m） */
  unitPricePerM: number;
}

export interface BaseboardEstimateRow {
  productId: string;
  productName: string;
  brand: string;
  /** 製品ごとの巾木合計延長（m） */
  lengthM: number;
  unitPrice: number;
  /** 金額（円） */
  cost: number;
}

/**
 * 巾木が有効な壁セグメント一覧を製品単位で集計する。
 * lengthM が 0 以下のセグメントは無視。同一 productId は延長を合算する。
 * 単価が 0 でも（延長を見せるため）行は生成する（金額は 0）。
 */
export function buildBaseboardRows(segments: BaseboardWallSegment[]): BaseboardEstimateRow[] {
  const map = new Map<string, BaseboardEstimateRow>();
  for (const s of segments) {
    if (!(s.lengthM > 0)) continue;
    const existing = map.get(s.productId);
    if (existing) {
      existing.lengthM += s.lengthM;
    } else {
      map.set(s.productId, {
        productId: s.productId,
        productName: s.productName,
        brand: s.brand,
        lengthM: s.lengthM,
        unitPrice: Number.isFinite(s.unitPricePerM) ? Math.max(0, s.unitPricePerM) : 0,
        cost: 0,
      });
    }
  }
  for (const row of map.values()) {
    row.cost = Math.round(row.lengthM * row.unitPrice);
  }
  return [...map.values()];
}

/** 巾木ラインの合計金額（円）。 */
export function baseboardTotalCost(rows: BaseboardEstimateRow[]): number {
  return rows.reduce((sum, r) => sum + r.cost, 0);
}
