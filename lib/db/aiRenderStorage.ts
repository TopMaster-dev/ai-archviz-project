import { getSupabase } from './supabaseClient.js';

// AIレンダリング/編集の生成画像のクラウド保存（履歴の永続化・260619 クライアント要望:「履歴を残したい」）。
//
// 背景: 生成画像を base64 データURLのまま履歴に埋め込むと、localStorage（~5MB）や projects.data(jsonb) が
// すぐ肥大化し、古い履歴から自動的に間引かれて消えていた。生成のたびに画像を Supabase Storage へ保存して
// 公開URL化し、履歴にはURL（軽量）だけを持たせることで、件数を増やしてもクラウドに長期保存できる。
//
// すべてベストエフォート（失敗時は従来どおり base64 を保持＝動作を壊さない）。
// 既存の 'user-uploads' バケット（所有者フォルダ書き込み可・公開読み取りのRLS）を再利用するため、新規マイグレ不要。
//
// 容量カウントについて（260626）: ここで保存する生成画像は {uid}/ai-render/... に置かれ、
// ホーム画面の使用量表示・容量警告メール（storage_usage_self / storage_warning_targets が storage.objects を
// 集計）に「含まれて」数えられる。ただし手動アップロード（uploads.ts の checkStorageCapacity）と異なり、
// 生成自体は容量上限でブロックしない（生成フロー中断を避けるため意図的）。＝上限は AI生成に対しては soft。

const BUCKET = 'user-uploads';

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const mime = m[1];
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  } catch {
    return null;
  }
}

function extOf(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

/**
 * 生成画像（base64 データURL）を Storage へ保存し公開URLを返す。
 *  - すでに http(s) URL ならそのまま返す（冪等）。
 *  - 未構成 / 未ログイン / 失敗時は null（呼び出し側は base64 のまま保持＝従来動作にフォールバック）。
 */
export async function uploadAiRenderImage(image: string, projectId?: string | null): Promise<string | null> {
  if (!image) return null;
  if (!image.startsWith('data:')) return image; // 既にURL
  const parsed = parseDataUrl(image);
  if (!parsed) return null;
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data: userData } = await sb.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) return null;
    const path = `${uid}/ai-render/${projectId ?? 'unsaved'}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extOf(parsed.mime)}`;
    const blob = new Blob([parsed.bytes as BlobPart], { type: parsed.mime });
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
      contentType: parsed.mime,
      upsert: false,
      cacheControl: '3600',
    });
    if (error) return null;
    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    return pub?.publicUrl ?? null;
  } catch {
    return null;
  }
}

/** データURLなら保存してURL化、失敗時は元の値を返す（常に文字列＝呼び出し側は分岐不要）。 */
export async function toStoredImage(image: string, projectId?: string | null): Promise<string> {
  return (await uploadAiRenderImage(image, projectId)) ?? image;
}

/**
 * 公開URLから user-uploads 内の ai-render パスを取り出す（該当しなければ null）。
 * 安全策として ai-render フォルダのオブジェクトのみ対象にし、素材（model/texture）は決して消さない。
 */
function aiRenderStoragePathFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string' || url.startsWith('data:')) return null;
  const marker = '/storage/v1/object/public/user-uploads/';
  const i = url.indexOf(marker);
  if (i < 0) return null;
  let path = url.slice(i + marker.length);
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  try {
    path = decodeURIComponent(path);
  } catch {
    /* デコード不能ならそのまま */
  }
  return path.includes('/ai-render/') ? path : null; // ai-render 以外（素材等）は対象外
}

/**
 * 生成画像（ai-render）の Storage 実体を削除して容量を解放する（ベストエフォート・260629）。
 * data: URL や user-uploads 以外 / ai-render 以外のURLは無視する（誤削除防止）。
 * RLS により本人フォルダ（先頭=auth.uid）のみ削除可能。
 */
export async function deleteAiRenderImages(urls: Array<string | null | undefined>): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const paths = Array.from(
    new Set(urls.map(aiRenderStoragePathFromUrl).filter((p): p is string => !!p)),
  );
  if (paths.length === 0) return;
  try {
    await sb.storage.from(BUCKET).remove(paths);
  } catch {
    /* ベストエフォート（容量解放の失敗で操作を妨げない） */
  }
}

/**
 * あるプロジェクトの生成画像（{uid}/ai-render/{projectId}/...）の Storage 実体をまとめて削除する。
 * プロジェクトの完全削除時に容量を解放するため（ベストエフォート）。素材（model/texture）は対象外。
 */
export async function deleteAiRenderImagesForProject(projectId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb || !projectId) return;
  try {
    const { data: userData } = await sb.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) return;
    const prefix = `${uid}/ai-render/${projectId}`;
    const { data: files } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000 });
    if (!files || files.length === 0) return;
    const paths = files.filter((f) => f.name).map((f) => `${prefix}/${f.name}`);
    if (paths.length > 0) await sb.storage.from(BUCKET).remove(paths);
  } catch {
    /* ベストエフォート */
  }
}

/**
 * 画像参照を「base64 データURL」に戻す（編集/書き出しでバイト列が必要なため）。
 *  - 既に data: URL ならそのまま返す。
 *  - http(s) URL（保存済み履歴）なら fetch してデータURL化（クロスオリジンの canvas 汚染を避けるため
 *    <img> ロードではなく fetch→Blob→DataURL で取得する）。失敗時は元の値を返す（呼び出し側でハンドリング）。
 */
export async function ensureDataUrl(image: string | null | undefined): Promise<string> {
  const img = image ?? '';
  if (!img || img.startsWith('data:')) return img;
  try {
    const res = await fetch(img);
    if (!res.ok) return img;
    const blob = await res.blob();
    return await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(typeof fr.result === 'string' ? fr.result : img);
      fr.onerror = () => resolve(img);
      fr.readAsDataURL(blob);
    });
  } catch {
    return img;
  }
}
