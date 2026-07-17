import type { FurnitureCatalogItem, Product, MaterialCategory } from '../types.js';
import type { UserUpload } from './db/uploads.js';
import { updateUserUploadMetadata } from './db/uploads.js';
import { normalizeModelUnit, unitGeometryScale, sanitizeGeometryScale } from '../utils/modelUnit.js';

// ユーザーアップロード資産（user_uploads）を、エディタが扱うカタログ型へ写像する純関数群。
//  - model   → FurnitureCatalogItem（家具カタログへ追加 → 2D/3Dで配置可能）
//  - texture → Product（素材パレットへ追加 → 面に適用可能）
// 実体は Supabase Storage の公開URL（storageUrl）。3D は useGLTF / TextureLoader が
// その URL を直接読み込む。

/** 素材パレットでユーザー資産を識別するブランド名（カテゴリ横断表示に使う）。 */
export const USER_UPLOAD_BRAND = 'マイアップロード';
/** 家具ストリップでアップロード家具がまとまるカテゴリ（type）。 */
export const UPLOAD_FURNITURE_TYPE = 'アップロード';

/** テクスチャに割り当て可能なカテゴリ（面の種別）。家具/建具はテクスチャ対象外。 */
export const TEXTURE_CATEGORIES: MaterialCategory[] = ['Wall', 'Floor', 'Ceiling'];

/** アップロードパネルのカテゴリ選択肢。value=null は「共通（全カテゴリに表示）」。 */
export const TEXTURE_CATEGORY_OPTIONS: { value: MaterialCategory | null; label: string }[] = [
  { value: null, label: '共通' },
  { value: 'Wall', label: '壁' },
  { value: 'Floor', label: '床' },
  { value: 'Ceiling', label: '天井' },
];

/** metadata.category を割当済みカテゴリ（Wall/Floor/Ceiling）として正規化。未割当/対象外は null（=共通）。 */
export function normalizeTextureCategory(raw: unknown): MaterialCategory | null {
  return TEXTURE_CATEGORIES.includes(raw as MaterialCategory) ? (raw as MaterialCategory) : null;
}

/** カテゴリ値（null=共通）の表示ラベル。 */
export function textureCategoryLabel(category: MaterialCategory | null): string {
  return TEXTURE_CATEGORY_OPTIONS.find((o) => o.value === category)?.label ?? '共通';
}

/** ファイル名から拡張子を除いた表示名。空なら fallback。 */
export function deriveUploadName(originalName: string | null, fallback = 'アップロード'): string {
  if (!originalName) return fallback;
  const noExt = originalName.replace(/\.[^./\\]+$/, '');
  return noExt.trim() || fallback;
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 3Dモデルのアップロードを家具カタログ項目へ。寸法(footprint2d)は metadata にあればそれを使い、
 * 無ければ undefined のまま返す（暫定 1m 角は付けない・260625）。未計測のものは ensureUploadFootprint が
 * バウンディングボックスを実測して footprint2d を埋め、カタログ家具と同じ表示ロジックに揃える。
 */
export function uploadToFurnitureItem(upload: UserUpload): FurnitureCatalogItem {
  const meta = (upload.metadata ?? {}) as Record<string, unknown>;
  const fp = (meta.footprint2d ?? {}) as { widthMm?: unknown; depthMm?: unknown };
  const widthMm = finite(fp.widthMm);
  const depthMm = finite(fp.depthMm);
  // アップロード時に入力した見積もり用メタ（データ名称・品番・メーカー名・商品金額・260630）。
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const metaName = str(meta.name);
  const metaBrand = str(meta.brand);
  const metaModelNumber = str(meta.modelNumber);
  const metaProductUrl = str(meta.productUrl);
  return {
    id: `upload-${upload.id}`,
    type: UPLOAD_FURNITURE_TYPE,
    // データ名称（入力）を優先、無ければファイル名。
    name: metaName || deriveUploadName(upload.originalName),
    url: upload.storageUrl,
    defaultScale: finite(meta.defaultScale) ?? 1,
    defaultY: finite(meta.defaultY) ?? 0,
    // 計測済み(metadata)のみ採用。未計測は undefined（DEFAULT/実測効果へフォールバック）。
    footprint2d: widthMm !== undefined && depthMm !== undefined ? { widthMm, depthMm } : undefined,
    forwardYawDeg: finite(meta.forwardYawDeg) ?? 0,
    // 取り込み単位(③・260717)の幾何プリスケール f_U（明示単位のみ・確定時に metadata へ保存済み）。
    modelUnitScale: sanitizeGeometryScale(finite(meta.modelUnitScale)) ?? undefined,
    // 見積もり連携メタ（配置時に handleAddFurniture が customBrand/modelNumber/customPrice/productUrl へ流す）。
    // 家具情報の編集（260715 #9）で updateUserUploadMetadata により台帳へ書き戻される。
    brand: metaBrand || undefined,
    modelNumber: metaModelNumber || undefined,
    price: finite(meta.price),
    productUrl: metaProductUrl || undefined,
  };
}

/**
 * アップロード(model)の寸法(footprint2d)を確保したカタログ項目を返す（260625・カタログ3Dと表示ロジックを揃える）。
 *  - metadata に footprint2d があれば即返す（再計測しない＝冪等）。
 *  - 無ければ computeGltfFootprintBaseMm でバウンディングボックスを実測（3D描画と同じ正規化）し、
 *    結果を updateUserUploadMetadata で永続化（best-effort: ゲスト/未構成では throw → 無視）。
 *  - 実測失敗時は footprint2d 未設定のまま（DEFAULT/ヒューリスティクスへフォールバック）。
 * 重い 3D ローダは動的 import で遅延読み込み（非エディタ画面のバンドルに含めない）。
 */
export async function ensureUploadFootprint(upload: UserUpload): Promise<FurnitureCatalogItem> {
  const item = uploadToFurnitureItem(upload);
  if (item.footprint2d) return item; // 計測済み（永続値）
  const meta = (upload.metadata ?? {}) as Record<string, unknown>;
  // 取り込み単位(③・260717)の幾何プリスケール。明示単位なら描画と同一のスケールで実寸計測する。
  const geomScale = unitGeometryScale(normalizeModelUnit(meta.modelUnit));
  try {
    const { computeGltfFootprintBaseMm } = await import('../utils/furnitureModelFootprint.js');
    const dims = await computeGltfFootprintBaseMm(upload.storageUrl, geomScale);
    item.footprint2d = { widthMm: dims.width, depthMm: dims.depth };
    try {
      await updateUserUploadMetadata(upload.id, {
        ...(upload.metadata ?? {}),
        footprint2d: { widthMm: dims.width, depthMm: dims.depth },
      });
    } catch {
      /* 永続化失敗（ゲスト/未構成/ネットワーク）→ 当セッションは実測値で表示。次回起動で再計測。 */
    }
  } catch {
    /* 実測失敗（モデル不正/CORS 等）→ footprint2d 未設定のまま。 */
  }
  return item;
}

/**
 * テクスチャのアップロードを素材（Product）へ。
 * metadata.category が壁/床/天井なら自カテゴリのみ表示。未割当（共通）なら crossCategory=true で
 * 全カテゴリのパレットに表示する（後方互換: 旧アップロードは category 未設定＝共通として従来どおり）。
 */
export function uploadToProduct(upload: UserUpload): Product {
  const meta = (upload.metadata ?? {}) as Record<string, unknown>;
  const assigned = normalizeTextureCategory(meta.category);
  // 建材アップロード時に入力したデータ名称・メーカー名・品番・商品金額（260630/260702）。見積もりへ反映する。
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const metaName = str(meta.name);
  const metaBrand = str(meta.brand);
  const metaModelNumber = str(meta.modelNumber);
  // 商品金額（円・整数）。未入力/不正/0 は 0（未設定）。
  const metaPrice =
    typeof meta.price === 'number' && Number.isFinite(meta.price) && meta.price > 0 ? Math.round(meta.price) : 0;
  return {
    id: `upload-tex-${upload.id}`,
    name: metaName || deriveUploadName(upload.originalName, 'テクスチャ'), // 入力したデータ名称を優先
    brand: metaBrand || USER_UPLOAD_BRAND, // メーカー名未入力時は識別用の既定ブランド
    modelNumber: metaModelNumber || undefined,
    category: assigned ?? 'Wall', // 共通時のプレースホルダ（表示は crossCategory が制御）
    crossCategory: assigned === null,
    pricePerUnit: metaPrice,
    unit: '㎡',
    lossFactor: 0,
    textureUrl: upload.storageUrl,
    color: '#ffffff',
    pbr: { roughness: 0.8, metalness: 0, reflectivity: 0, glossiness: 'Matte', normalMapStrength: 0 },
    promptHint: '(ユーザーアップロード)',
  };
}

/**
 * その素材がユーザーアップロード由来か（素材パレットのカテゴリ横断表示等に使用）。
 * メーカー名入力でブランドが任意値になり得るため、ブランドではなく id 接頭辞で判定する（260630）。
 */
export function isUserUploadProduct(p: Pick<Product, 'id'>): boolean {
  return typeof p.id === 'string' && p.id.startsWith('upload-tex-');
}
