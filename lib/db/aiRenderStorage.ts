import { getSupabase } from './supabaseClient.js';

// AIレンダリング/編集の生成画像のクラウド保存（履歴の永続化・260619 クライアント要望:「履歴を残したい」）。
//
// 背景: 生成画像を base64 データURLのまま履歴に埋め込むと、localStorage（~5MB）や projects.data(jsonb) が
// すぐ肥大化し、古い履歴から自動的に間引かれて消えていた。生成のたびに画像を Supabase Storage へ保存して
// 公開URL化し、履歴にはURL（軽量）だけを持たせることで、件数を増やしてもクラウドに長期保存できる。
//
// すべてベストエフォート（失敗時は従来どおり base64 を保持＝動作を壊さない）。
// 既存の 'user-uploads' バケット（所有者フォルダ書き込み可・公開読み取りのRLS）を再利用するため、新規マイグレ不要。

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
