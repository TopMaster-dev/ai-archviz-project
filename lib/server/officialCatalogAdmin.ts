import { v2 as cloudinary } from 'cloudinary';

/**
 * 公式カタログ（Cloudinary 3d_assets・運営アップロード）のメタデータ管理（260727・クライアント要望）。
 * 保存先は各 raw リソースの context.custom（furnitureCatalogService の footprint_* と同じ規約 "k=v|k=v"）。
 *  - setOfficial3dMeta: アップロード直後に向き/単位/寸法(footprint)/カテゴリを1回で書き込む（#1・#3）。
 *  - listOfficialModelCategories: 既存カテゴリ一覧（select 用・#3/#4）。
 *  - renameOfficialModelCategory / unassignOfficialModelCategory: カテゴリの改名/解除（#4・アセットは削除しない）。
 * すべて運営（verifyAdmin）専用の呼び出し元から使う。API Secret はサーバ内のみ。
 */

// api/furniture.ts と同じ資格情報解決（cloud_name は VITE_ 版もフォールバック）。呼び出し元での config 有無に依存しない。
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export const META_CATEGORY_KEY = 'category';
const RAW = { resource_type: 'raw' as const, type: 'upload' as const };

/** context 値のサニタイズ: 区切り記号(|,=)と改行を除去し、トリム＋長さ制限。 */
function sanitizeContextValue(v: string, max = 60): string {
  return String(v).replace(/[|=\r\n]/g, ' ').trim().slice(0, max);
}

/** context オブジェクト → "k=v|k=v" 文字列（空値キーは出さない）。 */
function serializeContext(obj: Record<string, string>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${sanitizeContextValue(v)}`)
    .join('|');
}

/** リソースの現在の context.custom を取得（存在しない/失敗時は空）。footprint_* を消さないための read-merge 用。 */
async function readContext(publicId: string): Promise<Record<string, string>> {
  try {
    const r: any = await cloudinary.api.resource(publicId, { ...RAW, context: true });
    const custom = r?.context?.custom && typeof r.context.custom === 'object' ? r.context.custom : {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(custom)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export interface Official3dMetaInput {
  widthMm?: number;
  depthMm?: number;
  forwardYawDeg?: number;
  uprightXDeg?: number;
  unitScale?: number | null;
  unit?: string;
  category?: string;
}

/** 数値 context キーを Math.round して埋める。undefined は据え置き（既存を消さない）。 */
function num(v: unknown): string | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : undefined;
}

/**
 * 1リソースへ向き/単位/footprint/カテゴリをまとめて書き込む（read-merge-write で footprint_* 等を保持）。
 * unitScale は小数のため round しない。category 空文字は「未設定」として扱い書かない。
 */
export async function setOfficial3dMeta(publicId: string, meta: Official3dMetaInput): Promise<{ ok: boolean; error?: string }> {
  if (!publicId) return { ok: false, error: 'publicId が必要です。' };
  try {
    const existing = await readContext(publicId);
    const merged: Record<string, string> = { ...existing };
    const w = num(meta.widthMm);
    const d = num(meta.depthMm);
    const yaw = num(meta.forwardYawDeg);
    const up = num(meta.uprightXDeg);
    if (w) merged.footprint_width_mm = w;
    if (d) merged.footprint_depth_mm = d;
    if (yaw != null) merged.forward_yaw_deg = yaw;
    if (up != null) merged.model_upright_x_deg = up;
    if (meta.unitScale != null && Number.isFinite(meta.unitScale) && meta.unitScale > 0) {
      merged.model_unit_scale = String(meta.unitScale);
      if (meta.unit) merged.model_unit = sanitizeContextValue(meta.unit, 12);
    }
    const cat = (meta.category ?? '').trim();
    if (cat) merged[META_CATEGORY_KEY] = sanitizeContextValue(cat, 40);
    await cloudinary.api.update(publicId, { ...RAW, context: serializeContext(merged) });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'update failed' };
  }
}

/** 既定の推奨カテゴリ（初回でアセットが未分類でも select に候補を出すためのシード）。 */
const CATEGORY_SEED = ['ソファ', 'チェア', 'テーブル', 'デスク', 'ベッド', '照明', '収納', 'ラグ', '植物', 'その他'];

/** 3d_assets を走査して context.category の distinct 値＋件数を返す（シードとマージ）。 */
export async function listOfficialModelCategories(): Promise<{ categories: Array<{ name: string; count: number }> }> {
  const counts = new Map<string, number>();
  for (const s of CATEGORY_SEED) counts.set(s, 0);
  try {
    const res: any = await cloudinary.search.expression('folder:3d_assets').with_field('context').max_results(500).execute();
    const resources: any[] = Array.isArray(res?.resources) ? res.resources : [];
    for (const r of resources) {
      const custom = r?.context?.custom && typeof r.context.custom === 'object' ? r.context.custom : {};
      const c = typeof custom[META_CATEGORY_KEY] === 'string' ? custom[META_CATEGORY_KEY].trim() : '';
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  } catch {
    /* 資格情報なし等 → シードのみ返す */
  }
  const categories = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return { categories };
}

/** category=from のアセットを列挙して1件ずつ context.category を to へ（best-effort・footprint_* 保持）。 */
export async function renameOfficialModelCategory(from: string, to: string): Promise<{ updated: number; failed: number }> {
  const target = (to ?? '').trim();
  const src = (from ?? '').trim();
  if (!src || !target) return { updated: 0, failed: 0 };
  let updated = 0;
  let failed = 0;
  try {
    const res: any = await cloudinary.search.expression('folder:3d_assets').with_field('context').max_results(500).execute();
    const resources: any[] = Array.isArray(res?.resources) ? res.resources : [];
    for (const r of resources) {
      const custom = r?.context?.custom && typeof r.context.custom === 'object' ? r.context.custom : {};
      if (typeof custom[META_CATEGORY_KEY] !== 'string' || custom[META_CATEGORY_KEY].trim() !== src) continue;
      const res2 = await setOfficial3dMeta(String(r.public_id), { category: target });
      if (res2.ok) updated += 1;
      else failed += 1;
    }
  } catch {
    failed += 1;
  }
  return { updated, failed };
}

/**
 * カテゴリの「削除」= 安全な解除（アセットは絶対に消さない）。該当アセットから category キーだけを外し、
 * ファイル名推定（inferTypeFromFilename）へフォールバックさせる。footprint_* 等は保持。
 */
export async function unassignOfficialModelCategory(category: string): Promise<{ updated: number; failed: number }> {
  const src = (category ?? '').trim();
  if (!src) return { updated: 0, failed: 0 };
  let updated = 0;
  let failed = 0;
  try {
    const res: any = await cloudinary.search.expression('folder:3d_assets').with_field('context').max_results(500).execute();
    const resources: any[] = Array.isArray(res?.resources) ? res.resources : [];
    for (const r of resources) {
      const custom = r?.context?.custom && typeof r.context.custom === 'object' ? r.context.custom : {};
      if (typeof custom[META_CATEGORY_KEY] !== 'string' || custom[META_CATEGORY_KEY].trim() !== src) continue;
      const publicId = String(r.public_id);
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(custom)) if (typeof v === 'string' && k !== META_CATEGORY_KEY) merged[k] = v;
      try {
        await cloudinary.api.update(publicId, { ...RAW, context: serializeContext(merged) });
        updated += 1;
      } catch {
        failed += 1;
      }
    }
  } catch {
    failed += 1;
  }
  return { updated, failed };
}
