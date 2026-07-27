import { getUserUpload, updateUserUploadMetadata, listUserUploads } from './db/uploads.js';
import type { UserUpload } from './db/uploads.js';

/**
 * アップロード台帳（user_uploads.metadata）への商品メタ書き戻し（260728 クライアント #6）。
 *
 * クライアント要望:「ユーザーがアップロードしたデータは、変更内容をアップロード情報自体を書き換えるように」。
 * 見積パネル／ホームのマイアップロードのどちらから編集しても、この1本を通して台帳を更新する。
 *
 * 重要: updateUserUploadMetadata は metadata を**全置換**する。古いスナップショットへマージすると
 * 他所が書いたキー（thumbnailUrl / footprint2d / modelUnitScale / modelUprightXDeg / category …）を
 * 無言で消してしまうため、**必ず書き込み直前に最新行を取り直してからマージする**。
 * 取得に失敗したら（throw）書き込まない＝古い値で上書きしない。
 */
export interface ProductMetaPatch {
  name?: string;
  brand?: string;
  modelNumber?: string;
  productUrl?: string;
  /** 商品金額（建材は㎡単価として使われる）。0以下は「未設定」としてキーを削除する。 */
  price?: number;
}

/** metadata に載せるキー名（uploadToProduct / uploadToFurnitureItem の読み出しと対応）。 */
const TEXT_KEYS = ['name', 'brand', 'modelNumber', 'productUrl'] as const;

/**
 * patch を既存 metadata へマージする（純関数・テスト用に公開）。
 * 空文字は「未設定へ戻す」＝キー削除。price は 0以下/非有限で削除。undefined は変更しない。
 */
export function mergeUploadMetadata(
  base: Record<string, unknown>,
  patch: ProductMetaPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const k of TEXT_KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    const trimmed = v.trim();
    if (trimmed) next[k] = trimmed;
    else delete next[k];
  }
  if (patch.price !== undefined) {
    if (Number.isFinite(patch.price) && (patch.price as number) > 0) next.price = patch.price;
    else delete next.price;
  }
  return next;
}

/**
 * uploadId を指定して台帳のメタを更新する。成功で更新後の行、対象が無ければ null。
 * ゲスト/未構成（Supabase 無し）では getUserUpload が null を返すので何もしない。
 */
export async function persistUploadMeta(uploadId: string, patch: ProductMetaPatch): Promise<UserUpload | null> {
  if (!uploadId) return null;
  const fresh = await getUserUpload(uploadId); // 読み取り失敗は throw＝書き込まない
  if (!fresh) return null;
  const merged = mergeUploadMetadata((fresh.metadata ?? {}) as Record<string, unknown>, patch);
  return await updateUserUploadMetadata(uploadId, merged);
}

/**
 * 建材（テクスチャ）の Product.id（`upload-tex-<uploadId>`）から台帳を更新する。
 * カタログ素材や既定素材（decisive でない id）は対象外＝何もしない。
 */
export async function persistUploadMetaByProductId(
  productId: string,
  patch: ProductMetaPatch,
): Promise<UserUpload | null> {
  const PREFIX = 'upload-tex-';
  if (!productId?.startsWith(PREFIX)) return null;
  return await persistUploadMeta(productId.slice(PREFIX.length), patch);
}

/**
 * 3Dモデル（家具）は FurnitureItem がカタログIDを持たないため、storageUrl で台帳を引き当てる
 * （既存 persistUploadFurnitureMeta と同じ探索）。見つからなければ null。
 */
export async function persistUploadMetaByModelUrl(
  modelUrl: string,
  patch: ProductMetaPatch,
): Promise<UserUpload | null> {
  if (!modelUrl) return null;
  const models = await listUserUploads('model');
  const up = models.find((u) => u.storageUrl === modelUrl);
  if (!up) return null;
  return await persistUploadMeta(up.id, patch);
}
