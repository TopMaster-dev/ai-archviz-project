import { getSupabase } from './supabaseClient.js';

// BYOK のキー保管（user_api_keys テーブル / RLS で本人のみ読み書き可）。
//
// セキュリティ注記（MVP範囲）:
//   実効的な保護は RLS（行レベルセキュリティ）に依存する。本格的な暗号化サービス層は
//   Phase 2 の堅牢化項目とし、現状は base64 で難読化して key_ciphertext に格納する
//   （DB ダンプ等での平文の直接露出を避ける程度の措置）。キーはユーザー自身のもの。

const PROVIDER = 'gemini';

// Gemini の API キーは ASCII（AIza...）のため btoa/atob で十分。暗号化ではなく難読化。
function obfuscate(raw: string): string {
  return btoa(raw);
}

function deobfuscate(stored: string): string {
  try {
    return atob(stored);
  } catch {
    return '';
  }
}

/** ユーザーの Gemini キーを保存（upsert）。 */
export async function saveGeminiKey(rawKey: string): Promise<void> {
  const key = rawKey.trim();
  if (!key) throw new Error('APIキーが空です。');
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、APIキーを保存できません。');
  const { data: userData } = await sb.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('未ログインのため、APIキーを保存できません。');
  const { error } = await sb.from('user_api_keys').upsert(
    {
      user_id: userId,
      provider: PROVIDER,
      key_ciphertext: obfuscate(key),
      last4: key.slice(-4),
    },
    { onConflict: 'user_id,provider' },
  );
  if (error) throw error;
}

/** ユーザーの Gemini キーを読み込む（無ければ null）。 */
export async function loadGeminiKey(): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from('user_api_keys')
    .select('key_ciphertext')
    .eq('provider', PROVIDER)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const raw = deobfuscate((data as { key_ciphertext: string }).key_ciphertext);
  return raw || null;
}

/** ユーザーの Gemini キーを削除。 */
export async function clearGeminiKey(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { data: userData } = await sb.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return;
  const { error } = await sb
    .from('user_api_keys')
    .delete()
    .eq('user_id', userId)
    .eq('provider', PROVIDER);
  if (error) throw error;
}
