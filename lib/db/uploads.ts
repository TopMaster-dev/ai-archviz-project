import { getSupabase } from './supabaseClient.js';
import { STORAGE_SOFT_LIMIT_BYTES } from '../storageLimits.js';

// ユーザーアップロード資産（3Dモデル / テクスチャ）の保存・一覧・削除。
//
// 保存先: Supabase Storage バケット 'user-uploads'（public）。
// 台帳:   user_uploads テーブル（0003）。owner_id は RLS により auth.uid() に一致する行のみ
//         読み書き可。管理画面は service_role で admin_user_uploads を全件参照する。
//
// 実体は Storage、メタデータ/所在は台帳、という二層構成（0003 の設計どおり）。

const BUCKET = 'user-uploads';

/** いま UI で扱うアップロード種別（テーブル enum の部分集合）。 */
export type UploadKind = 'model' | 'texture';

/** 台帳 1 行（UI 表示・エディタ取り込みに必要な列のみ）。 */
export interface UserUpload {
  id: string;
  kind: UploadKind;
  storageUrl: string;
  publicId: string | null;
  originalName: string | null;
  bytes: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** 種別ごとの受け入れ拡張子（バリデーションと file input accept に使用）。 */
export const ACCEPTED_EXT: Record<UploadKind, string[]> = {
  model: ['.glb', '.gltf', '.fbx', '.obj'],
  texture: ['.png', '.jpg', '.jpeg', '.webp'],
};

/** 種別ごとのサイズ上限（バイト）。Supabase の既定オブジェクト上限内に収める。 */
export const MAX_BYTES: Record<UploadKind, number> = {
  model: 40 * 1024 * 1024, // 40MB
  texture: 12 * 1024 * 1024, // 12MB
};

/**
 * ストレージのパスに使える形へファイル名を正規化（純粋関数・テスト対象）。
 * 拡張子は分離して保持する（非ASCIIのみの名前でも .glb 等を失わないように）。
 */
export function sanitizeUploadFileName(name: string): string {
  const trimmed = (name || 'file').trim();
  const dot = trimmed.lastIndexOf('.');
  const rawBase = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  const rawExt = dot > 0 ? trimmed.slice(dot) : '';
  const base =
    rawBase
      .replace(/[^\w\-]+/g, '_') // 危険/非ASCIIは _ へ
      .replace(/_{2,}/g, '_') // 連続 _ を畳む
      .replace(/^_+|_+$/g, '') || 'file'; // 端の _ を除去、空なら file
  const ext = rawExt.replace(/[^\w.]+/g, ''); // 拡張子は英数と . のみ残す
  return base + ext;
}

/** Storage 上の保存パスを組み立てる（純粋関数・テスト対象）。先頭フォルダ=ユーザーIDで RLS と一致。 */
export function buildStoragePath(userId: string, kind: UploadKind, fileName: string, timestamp: number): string {
  return `${userId}/${kind}/${timestamp}-${sanitizeUploadFileName(fileName)}`;
}

/** ファイルの拡張子（小文字, 先頭ドット付き）。無ければ ''。 */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/** アップロード前のクライアント側バリデーション。問題があればメッセージを返す（無ければ null）。 */
export function validateUpload(file: File, kind: UploadKind): string | null {
  const ext = extOf(file.name);
  if (!ACCEPTED_EXT[kind].includes(ext)) {
    return `対応していない形式です（${ACCEPTED_EXT[kind].join(' / ')} のみ）。`;
  }
  if (file.size > MAX_BYTES[kind]) {
    const mb = Math.round(MAX_BYTES[kind] / (1024 * 1024));
    return `ファイルが大きすぎます（上限 ${mb}MB）。`;
  }
  return null;
}

// 容量上限（管理表 row 31）は lib/storageLimits.ts を単一の真実源とし、ここから再エクスポートする
// （既存の import 互換: UploadPanel などは uploads.ts から取り込む）。
export { STORAGE_SOFT_LIMIT_BYTES };

/**
 * 追加アップロードが総容量のソフト上限を超えるか判定する（純粋関数・テスト対象）。
 * 既に上限到達、または今回の追加で上限超過となる場合はユーザー向けメッセージを返す（問題なければ null）。
 */
export function checkStorageCapacity(
  currentTotalBytes: number,
  addBytes: number,
  limit: number = STORAGE_SOFT_LIMIT_BYTES,
): string | null {
  const mb = Math.round(limit / (1024 * 1024));
  if (currentTotalBytes >= limit) {
    return `ストレージ容量の上限（${mb}MB）に達しています。不要なアップロードを削除してから追加してください。`;
  }
  if (currentTotalBytes + addBytes > limit) {
    return `このファイルを追加すると容量上限（${mb}MB）を超えます。不要なアップロードを削除してください。`;
  }
  return null;
}

interface UploadRow {
  id: string;
  kind: UploadKind;
  storage_url: string;
  public_id: string | null;
  original_name: string | null;
  bytes: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function mapRow(row: UploadRow): UserUpload {
  return {
    id: row.id,
    kind: row.kind,
    storageUrl: row.storage_url,
    publicId: row.public_id,
    originalName: row.original_name,
    bytes: row.bytes,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

const SELECT_COLS = 'id, kind, storage_url, public_id, original_name, bytes, metadata, created_at';

/**
 * ファイルを Supabase Storage へアップロードし、user_uploads 台帳に記録する。
 * Storage 書き込み成功後に台帳 INSERT に失敗した場合は、孤児オブジェクトを掃除する。
 */
export async function uploadUserFile(
  file: File,
  kind: UploadKind,
  options: { projectId?: string | null; metadata?: Record<string, unknown>; timestamp?: number } = {},
): Promise<UserUpload> {
  const invalid = validateUpload(file, kind);
  if (invalid) throw new Error(invalid);

  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、アップロードできません。');
  const { data: userData } = await sb.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('未ログインのため、アップロードできません。');

  const ts = options.timestamp ?? Date.now();
  const path = buildStoragePath(userId, kind, file.name, ts);

  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type || undefined,
    cacheControl: '3600',
  });
  if (upErr) throw upErr;

  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
  const storageUrl = pub.publicUrl;

  const { data: row, error: insErr } = await sb
    .from('user_uploads')
    .insert({
      owner_id: userId,
      kind,
      storage_provider: 'supabase',
      storage_url: storageUrl,
      public_id: path,
      original_name: file.name,
      bytes: file.size,
      project_id: options.projectId ?? null,
      metadata: options.metadata ?? {},
    })
    .select(SELECT_COLS)
    .single();

  if (insErr) {
    // 台帳に残せないアップロードは追跡不能になるため、Storage 側を巻き戻す。
    await sb.storage
      .from(BUCKET)
      .remove([path])
      .catch(() => {});
    throw insErr;
  }

  return mapRow(row as UploadRow);
}

/** 本人のアップロード一覧（新しい順）。kind 指定で絞り込み。未構成/未ログインは空配列。 */
export async function listUserUploads(kind?: UploadKind): Promise<UserUpload[]> {
  const sb = getSupabase();
  if (!sb) return [];
  let query = sb.from('user_uploads').select(SELECT_COLS).order('created_at', { ascending: false });
  if (kind) query = query.eq('kind', kind);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as UploadRow[]).map(mapRow);
}

/**
 * 台帳のメタデータを置き換える（カテゴリ割当の変更などに使用）。
 * metadata 全体を渡す（呼び出し側で既存 metadata とマージして渡すこと）。更新後の行を返す。
 */
export async function updateUserUploadMetadata(
  id: string,
  metadata: Record<string, unknown>,
): Promise<UserUpload> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、更新できません。');
  const { data, error } = await sb
    .from('user_uploads')
    .update({ metadata })
    .eq('id', id)
    .select(SELECT_COLS)
    .single();
  if (error) throw error;
  return mapRow(data as UploadRow);
}

/** アップロードを削除（Storage 実体 → 台帳の順。実体削除失敗は無視して台帳は必ず消す）。 */
export async function deleteUserUpload(upload: Pick<UserUpload, 'id' | 'publicId'>): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  if (upload.publicId) {
    await sb.storage
      .from(BUCKET)
      .remove([upload.publicId])
      .catch(() => {});
  }
  const { error } = await sb.from('user_uploads').delete().eq('id', upload.id);
  if (error) throw error;
}
