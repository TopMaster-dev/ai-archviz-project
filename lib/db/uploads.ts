import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, getSupabaseConfig } from './supabaseClient.js';
import { STORAGE_SOFT_LIMIT_BYTES, STORAGE_WARN_FRACTION, STORAGE_WARN_THRESHOLD_BYTES, FILE_SIZE_WARN_BYTES } from '../storageLimits.js';
import { downsizeImageFile } from '../../utils/downsizeImageFile.js';

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
  texture: ['.png', '.jpg', '.jpeg', '.webp'], // 代表例（説明文用）。実際の受け入れは validateUpload の画像判定で広い。
};

/**
 * 建材画像で受け入れる拡張子（MIME 欠落環境でのフォールバック判定用）。
 * 3Dビューの素材取り込み（input accept="image/*"）に合わせ、画像ファイル全般を許可する（260630・クライアント要望）。
 */
export const IMAGE_EXT = [
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg', '.tif', '.tiff', '.ico', '.heic', '.heif',
];

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
  if (kind === 'texture') {
    // 建材画像は 3Dビューの素材取り込み（accept="image/*"）に合わせ、画像ファイル全般を受け入れる（260630）。
    // MIME が image/* なら許可。MIME が取れない環境では既知の画像拡張子で判定する。
    const isImage = (file.type || '').startsWith('image/') || IMAGE_EXT.includes(ext);
    if (!isImage) return '対応していない形式です（画像ファイルを選択してください）。';
  } else if (!ACCEPTED_EXT[kind].includes(ext)) {
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
export { STORAGE_SOFT_LIMIT_BYTES, STORAGE_WARN_FRACTION, STORAGE_WARN_THRESHOLD_BYTES, FILE_SIZE_WARN_BYTES };

/**
 * 1ファイルが「大きめ」（既定 5MB 以上）のとき警告文を返す（無ければ null）。260716。
 * テクスチャは自動縮小するので情報表示、3Dモデルは縮小できないため注意喚起（続行/中止の確認に使う）。
 */
export function fileSizeWarning(file: File, kind: UploadKind): string | null {
  if (!file || file.size < FILE_SIZE_WARN_BYTES) return null;
  const mb = (file.size / (1024 * 1024)).toFixed(1);
  return kind === 'texture'
    ? `画像サイズが大きめです（${mb}MB）。自動的に縮小してアップロードします。`
    : `ファイルサイズが大きめです（${mb}MB）。3Dの表示や動作が重くなる場合があります。可能なら最適化（メッシュ削減・テクスチャ圧縮）してからアップロードしてください。`;
}

/**
 * 容量がしきい値（70MB）を超えた本人へ、警告メールを「即時」送るようサーバへ依頼する（ベストエフォート）。
 * 日次 cron を待たずに通知するため、アップロードで上限に近づいた直後に呼ぶ。
 * 未ログイン/SMTP未設定/サーバ未構成では送られない（サーバ側で判定）。再送はサーバのクールダウンで防止。
 * 例外は投げない（通知の失敗で操作を妨げない）。
 */
export async function notifyStorageWarningSelf(): Promise<void> {
  try {
    const sb = getSupabase();
    if (!sb) return;
    const token = (await sb.auth.getSession()).data.session?.access_token;
    if (!token) return;
    await fetch('/api/storage-warning-self', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    /* ベストエフォート */
  }
}

/** ホーム画面の使用量表示で扱う、種別ごと＋合計のバイト数。deleted=削除済(一時保管中)のAI生成画像。 */
export interface StorageUsage {
  totalBytes: number;
  byKind: { model: number; texture: number; aiRender: number; deleted: number; other: number };
}

/**
 * 本人の Storage 使用量（バケット実体の合計）を種別ごとに取得する。
 * user_uploads 台帳ではなく storage.objects を数える RPC（storage_usage_self）を使うため、
 * 台帳に記録しない AI生成画像（ai-render フォルダ）も含まれる。
 * RPC 未適用 / 未構成 / 失敗時は null（呼び出し側は台帳合計にフォールバックして表示を壊さない）。
 */
export async function getStorageUsageSelf(): Promise<StorageUsage | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.rpc('storage_usage_self');
  if (error || !data) return null;
  const d = data as { total?: unknown; by_kind?: Record<string, unknown> };
  const rawTotal = Number(d.total);
  if (!Number.isFinite(rawTotal) || rawTotal < 0) return null; // RPC の形が不正 → 台帳合計にフォールバック
  const bk = d.by_kind ?? {};
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const model = num(bk.model);
  const texture = num(bk.texture);
  const aiRender = num(bk['ai-render']);
  const deleted = num(bk.deleted);
  return {
    totalBytes: rawTotal,
    byKind: {
      model,
      texture,
      aiRender,
      deleted,
      other: Math.max(0, rawTotal - (model + texture + aiRender + deleted)),
    },
  };
}

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
 * Storage バケットへファイルをアップロードする（大きいファイルの進捗表示のための内部ヘルパ・260629）。
 * 可能なら XHR で進捗（onProgress: 0〜1）を通知しつつ送信する。SDK の upload と同じマルチパート形式
 * （FormData に cacheControl と、空フィールド名でファイルを append）を厳密に再現するため、サーバ側の
 * 受け口・できあがるオブジェクト（storage.objects.metadata.size 等）は SDK 経由と同一になる。
 * URL/anonキー/アクセストークン/XHR/onProgress のいずれかが無い環境では SDK アップロードへフォールバック（進捗なし）。
 */
async function uploadFileToBucket(
  sb: SupabaseClient,
  bucket: string,
  path: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const cfg = getSupabaseConfig();
  let token: string | undefined;
  try {
    token = (await sb.auth.getSession()).data.session?.access_token;
  } catch {
    token = undefined;
  }

  if (typeof XMLHttpRequest !== 'undefined' && cfg && token && onProgress) {
    onProgress(0); // XHR 経路に入った時点で確定的な 0% を表示（SDK フォールバック時は呼ばれず＝不確定バー）
    await new Promise<void>((resolve, reject) => {
      const form = new FormData();
      form.append('cacheControl', '3600');
      form.append('', file); // SDK と同一: 空フィールド名でファイル本体を送る
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${cfg.url}/storage/v1/object/${bucket}/${path}`);
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('apikey', cfg.anonKey);
      xhr.setRequestHeader('x-upsert', 'false');
      // Content-Type はブラウザが multipart boundary 付きで自動設定する（手動設定しない）。
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(1);
          resolve();
        } else {
          let msg = `アップロードに失敗しました（HTTP ${xhr.status}）。`;
          try {
            const j = JSON.parse(xhr.responseText);
            if (j?.message) msg = String(j.message);
          } catch {
            /* レスポンスが JSON でない場合は既定メッセージ */
          }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('アップロード中に通信エラーが発生しました。'));
      xhr.onabort = () => reject(new Error('アップロードが中断されました。'));
      xhr.send(form);
    });
    return;
  }

  // フォールバック（XHR/設定が使えない環境）: SDK アップロード（進捗なし）。
  const { error } = await sb.storage.from(bucket).upload(path, file, {
    upsert: false,
    contentType: file.type || undefined,
    cacheControl: '3600',
  });
  if (error) throw error;
}

/**
 * ファイルを Supabase Storage へアップロードし、user_uploads 台帳に記録する。
 * Storage 書き込み成功後に台帳 INSERT に失敗した場合は、孤児オブジェクトを掃除する。
 * onProgress（0〜1）を渡すと、可能な環境では進捗を通知する（大きいファイルのアップロード表示用）。
 */
export async function uploadUserFile(
  file: File,
  kind: UploadKind,
  options: {
    projectId?: string | null;
    metadata?: Record<string, unknown>;
    timestamp?: number;
    onProgress?: (fraction: number) => void;
  } = {},
): Promise<UserUpload> {
  // テクスチャは大きすぎる画像を自動縮小（長辺2048/WebP）してから検証・保存する（260716）。
  // 縮小前提のため、元が上限(12MB)超でも縮小後に収まれば通る。失敗時は原本のまま検証に回る。
  let uploadFile = file;
  if (kind === 'texture') {
    try {
      uploadFile = (await downsizeImageFile(file)).file;
    } catch {
      uploadFile = file;
    }
  }
  const invalid = validateUpload(uploadFile, kind);
  if (invalid) throw new Error(invalid);

  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、アップロードできません。');
  const { data: userData } = await sb.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('未ログインのため、アップロードできません。');

  const ts = options.timestamp ?? Date.now();
  // 保存パス/拡張子は実際に保存する（縮小後）ファイルに合わせる（.webp 等・content-type と一致させる）。
  const path = buildStoragePath(userId, kind, uploadFile.name, ts);

  await uploadFileToBucket(sb, BUCKET, path, uploadFile, options.onProgress);

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
      original_name: file.name, // 表示は元のファイル名を保持（実体は縮小後の webp）
      bytes: uploadFile.size, // 実際に保存した（縮小後の）サイズを計上
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
