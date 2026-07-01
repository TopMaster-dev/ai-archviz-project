/**
 * 建材テクスチャの「実寸（mm）」メタデータ導出ユーティリティ。
 *
 * クライアント提供の画像仕様（sample_画像仕様.txt / サンゲツ系カタログ）に準拠:
 *   - リピート画像・タイル画像 : 「1mm = 1px」→ 画像のピクセル寸法がそのまま実寸(mm)
 *   - チップ画像               : 300px ≒ 38mm角（解像度 200dpi）→ mm = px / dpi * 25.4
 *   - ファイル名規則           : 品番 + "_" + 画像作成日(8桁) + 画像識別コード(1桁) + 連番(2桁)
 *       画像識別コード … P=施工例 / C=チップ / R=リピート・タイル1枚 / K=タイル組み合わせ
 *       K の連番先頭 … K01=流し貼り / K02=市松貼り / K03〜=その他 / K91〜=複数品番組み合わせ
 *
 * このモジュールは **依存ゼロ（standalone）** に保つこと。
 * サーバーレス関数（api/materials.ts）とフロントエンド（types.ts 経由）の双方から
 * import されるため、frontend 専用依存（@react-three/fiber を含む types.ts 等）を
 * 取り込んではならない。
 */

export type MaterialImageKind =
  | 'construction' // 施工例 (P)
  | 'chip' // チップ (C)
  | 'repeat' // リピート・タイル1枚 (R)
  | 'tile-combo' // タイル組み合わせ (K)
  | 'unknown';

export interface MaterialPhysical {
  /** リピート1枚あたりの実寸幅 (mm) */
  repeatWidthMm?: number;
  /** リピート1枚あたりの実寸高さ (mm) */
  repeatHeightMm?: number;
  /** 画像種別（ファイル名の識別コードから判定） */
  imageKind: MaterialImageKind;
  /** 解析できた品番（ファイル名先頭の部分） */
  productCode?: string;
  /** タイル組み合わせ時の貼り方コード（K01/K02 …） */
  combinationCode?: string;
  /** 実寸値の取得元（信頼度の判断・UI上書き判定に使用） */
  source: 'sidecar' | 'chip-dpi' | 'filename+pixels' | 'pixels-1mm' | 'none';
}

const CHIP_DPI = 200;
const MM_PER_INCH = 25.4;

const IMAGE_KIND_BY_CODE: Record<string, MaterialImageKind> = {
  P: 'construction',
  C: 'chip',
  R: 'repeat',
  K: 'tile-combo',
};

/**
 * Cloudinary public_id / ファイル名から、画像識別コード（P/C/R/K）と品番を解析する。
 * 例: "materials/sangetsu/floor/series/AB-1234_20260101R01" → { productCode: "AB-1234", kind: "repeat" }
 */
export function parseMaterialFilename(publicIdOrName: string): {
  productCode?: string;
  kind: MaterialImageKind;
  combinationCode?: string;
} {
  const base = (publicIdOrName.split('/').pop() || publicIdOrName).replace(
    /\.(jpe?g|png|webp|avif)$/i,
    '',
  );
  // 品番 _ 作成日(8桁) 識別コード(1桁: P/C/R/K) 連番(2桁以上)
  const m = base.match(/^(.*)_(\d{8})([PCRK])(\d{2,})$/i);
  if (!m) return { kind: 'unknown' };
  const code = m[3].toUpperCase();
  return {
    productCode: m[1],
    kind: IMAGE_KIND_BY_CODE[code] ?? 'unknown',
    combinationCode: code === 'K' ? `K${m[4].slice(0, 2)}` : undefined,
  };
}

/**
 * 実寸メタデータを導出する。優先順位:
 *   1) sidecar（メーカー同梱の実寸情報など）があれば最優先で採用
 *   2) チップ画像 → 200dpi 換算
 *   3) リピート/タイル画像 → 1mm = 1px
 *   4) 識別コード不明だがピクセル寸法あり → リピート前提で暫定導出（source='pixels-1mm'、UIで上書き可）
 */
export function deriveMaterialPhysical(opts: {
  publicId: string;
  widthPx?: number;
  heightPx?: number;
  sidecar?: { repeatWidthMm?: number; repeatHeightMm?: number };
}): MaterialPhysical {
  const { publicId, widthPx, heightPx, sidecar } = opts;
  const parsed = parseMaterialFilename(publicId);
  const hasPixels = !!widthPx && !!heightPx;

  if (sidecar && (sidecar.repeatWidthMm || sidecar.repeatHeightMm)) {
    return {
      repeatWidthMm: sidecar.repeatWidthMm,
      repeatHeightMm: sidecar.repeatHeightMm,
      imageKind: parsed.kind,
      productCode: parsed.productCode,
      combinationCode: parsed.combinationCode,
      source: 'sidecar',
    };
  }

  if (parsed.kind === 'chip' && hasPixels) {
    return {
      repeatWidthMm: pxToMmAtDpi(widthPx as number, CHIP_DPI),
      repeatHeightMm: pxToMmAtDpi(heightPx as number, CHIP_DPI),
      imageKind: 'chip',
      productCode: parsed.productCode,
      source: 'chip-dpi',
    };
  }

  if ((parsed.kind === 'repeat' || parsed.kind === 'tile-combo') && hasPixels) {
    return {
      repeatWidthMm: widthPx,
      repeatHeightMm: heightPx,
      imageKind: parsed.kind,
      productCode: parsed.productCode,
      combinationCode: parsed.combinationCode,
      source: 'filename+pixels',
    };
  }

  // フォールバック: クライアントの Cloudinary 命名が仕様と異なる場合に備え、
  // ピクセル寸法があれば 1mm=1px として暫定導出する。誤適用回避のため source を区別し、
  // 後段（UI）で実寸の手動上書きを可能にすること。
  if (hasPixels) {
    return {
      repeatWidthMm: widthPx,
      repeatHeightMm: heightPx,
      imageKind: parsed.kind,
      productCode: parsed.productCode,
      source: 'pixels-1mm',
    };
  }

  return { imageKind: parsed.kind, productCode: parsed.productCode, source: 'none' };
}

function pxToMmAtDpi(px: number, dpi: number): number {
  return Math.round((px / dpi) * MM_PER_INCH * 10) / 10;
}

/**
 * 実寸メタから「長辺/短辺」比と向き（横長か）を返す。**画像のピクセル縦横比ではなく実寸(mm)の比**。
 * K(タイル組み合わせ)など、画像ピクセル比 ≠ 実寸比 の素材でも実寸どおりにタイリングするために使う（260701）。
 * 例: 画像1824x342px・実寸2994x1000mm → longOverShort=2.994（ピクセル比 5.33 ではなく実寸比を採用）。
 * 実寸メタが無い（アップロード素材等）場合は null を返し、呼び出し側は画像ピクセル比へフォールバックする。
 */
export function physicalRealAspect(
  physical: MaterialPhysical | undefined,
): { longOverShort: number; landscape: boolean } | null {
  if (!physical) return null;
  const w = physical.repeatWidthMm;
  const h = physical.repeatHeightMm;
  if (!w || !h || !(w > 0) || !(h > 0)) return null;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (!(short > 0)) return null;
  return { longOverShort: long / short, landscape: w >= h };
}

/**
 * 実寸テクスチャ投影用: テクスチャ「短辺」の実寸（メートル）を決める。
 * 優先順位:
 *   1) 手動の textureScale（ユーザー調整）があればそれを使う
 *   2) 素材の実寸メタ（physical.repeatWidthMm/repeatHeightMm）の短辺
 *   3) 既定 1.0m
 * applyRealSizeTextureRepeat はこの「短辺実寸」と面の実寸からリピート数を算出する。
 */
export function effectiveTextureShortEdgeMeters(
  physical: MaterialPhysical | undefined,
  textureScaleOverride?: number,
): number {
  if (textureScaleOverride != null && Number.isFinite(textureScaleOverride)) {
    return textureScaleOverride;
  }
  if (physical && (physical.repeatWidthMm || physical.repeatHeightMm)) {
    const w = physical.repeatWidthMm ?? physical.repeatHeightMm ?? 0;
    const h = physical.repeatHeightMm ?? physical.repeatWidthMm ?? 0;
    const shortMm = Math.min(w, h);
    if (shortMm > 0) return shortMm / 1000;
  }
  return 1;
}
