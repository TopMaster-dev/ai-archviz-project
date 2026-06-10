import type { FurnitureCatalogItem, Product, MaterialCategory } from '../types.js';
import type { UserUpload } from './db/uploads.js';

// ユーザーアップロード資産（user_uploads）を、エディタが扱うカタログ型へ写像する純関数群。
//  - model   → FurnitureCatalogItem（家具カタログへ追加 → 2D/3Dで配置可能）
//  - texture → Product（素材パレットへ追加 → 面に適用可能）
// 実体は Supabase Storage の公開URL（storageUrl）。3D は useGLTF / TextureLoader が
// その URL を直接読み込む。

/** 素材パレットでユーザー資産を識別するブランド名（カテゴリ横断表示に使う）。 */
export const USER_UPLOAD_BRAND = 'マイアップロード';
/** 家具ストリップでアップロード家具がまとまるカテゴリ（type）。 */
export const UPLOAD_FURNITURE_TYPE = 'アップロード';

const MATERIAL_CATEGORIES: MaterialCategory[] = ['Floor', 'Wall', 'Ceiling', 'Furniture', 'Window'];

/** ファイル名から拡張子を除いた表示名。空なら fallback。 */
export function deriveUploadName(originalName: string | null, fallback = 'アップロード'): string {
  if (!originalName) return fallback;
  const noExt = originalName.replace(/\.[^./\\]+$/, '');
  return noExt.trim() || fallback;
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asCategory(v: unknown): MaterialCategory {
  return MATERIAL_CATEGORIES.includes(v as MaterialCategory) ? (v as MaterialCategory) : 'Wall';
}

/** 3Dモデルのアップロードを家具カタログ項目へ。寸法は metadata があれば優先、無ければ 1m 角の暫定値。 */
export function uploadToFurnitureItem(upload: UserUpload): FurnitureCatalogItem {
  const meta = (upload.metadata ?? {}) as Record<string, unknown>;
  const fp = (meta.footprint2d ?? {}) as { widthMm?: unknown; depthMm?: unknown };
  return {
    id: `upload-${upload.id}`,
    type: UPLOAD_FURNITURE_TYPE,
    name: deriveUploadName(upload.originalName),
    url: upload.storageUrl,
    defaultScale: finite(meta.defaultScale) ?? 1,
    defaultY: finite(meta.defaultY) ?? 0,
    footprint2d: {
      widthMm: finite(fp.widthMm) ?? 1000,
      depthMm: finite(fp.depthMm) ?? 1000,
    },
    forwardYawDeg: finite(meta.forwardYawDeg) ?? 0,
  };
}

/** テクスチャのアップロードを素材（Product）へ。カテゴリ横断で適用できるよう既定は 'Wall'。 */
export function uploadToProduct(upload: UserUpload): Product {
  const meta = (upload.metadata ?? {}) as Record<string, unknown>;
  return {
    id: `upload-tex-${upload.id}`,
    name: deriveUploadName(upload.originalName, 'テクスチャ'),
    brand: USER_UPLOAD_BRAND,
    category: asCategory(meta.category),
    pricePerUnit: 0,
    unit: '㎡',
    lossFactor: 0,
    textureUrl: upload.storageUrl,
    color: '#ffffff',
    pbr: { roughness: 0.8, metalness: 0, reflectivity: 0, glossiness: 'Matte', normalMapStrength: 0 },
    promptHint: '(ユーザーアップロード)',
  };
}

/** その素材がユーザーアップロード由来か（素材パレットのカテゴリ横断表示に使用）。 */
export function isUserUploadProduct(p: Pick<Product, 'brand'>): boolean {
  return p.brand === USER_UPLOAD_BRAND;
}
