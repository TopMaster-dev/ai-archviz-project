/**
 * 巾木（baseboard）見積ラインの集計。
 *
 * クライアント要望（260613 / 管理表 row 238）:「壁延長距離からの巾木計算」。
 * 巾木が有効な壁の延長距離（m）を製品ごとに合計し、m 単価（円/m）を掛けて金額を出す。
 * 面積ベースの建材ラインとは単位（m）が異なるため、別ラインとして扱う。
 */

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
