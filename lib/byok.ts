import { saveGeminiKey, loadGeminiKey, clearGeminiKey } from './db/apiKeys.js';

// BYOK（Bring Your Own Key）ランタイム。
// 各ユーザーが自分の Gemini API キーを保存し、生成リクエスト時にそのキーを使う
// （サーバ側の共有キーへの依存を排除する。クライアントの API コストをユーザー負担にしない要件）。
//
// 方針:
//  - キーは Supabase の user_api_keys に RLS 保護で保管し、ログイン直後にこのメモリ
//    キャッシュへ読み込む。生成 fetch では x-gemini-key ヘッダとして都度送る。
//  - キー本体は DOM やログに出さない（表示用に末尾4桁のみ保持）。

let cachedKey: string | null = null;
let cachedLast4: string | null = null;

function setCache(key: string | null): void {
  const trimmed = key && key.trim() ? key.trim() : null;
  cachedKey = trimmed;
  cachedLast4 = trimmed ? trimmed.slice(-4) : null;
}

/** メモリ上のキャッシュキー（未設定なら null）。 */
export function getCachedGeminiKey(): string | null {
  return cachedKey;
}

/** 表示用の末尾4桁（未設定なら null）。 */
export function getCachedGeminiKeyLast4(): string | null {
  return cachedLast4;
}

/** 生成 fetch に展開する認証ヘッダ。キー未設定なら空オブジェクト。 */
export function geminiAuthHeaders(): Record<string, string> {
  return cachedKey ? { 'x-gemini-key': cachedKey } : {};
}

/** Supabase からキーを読み込みキャッシュする（ログイン直後に呼ぶ）。 */
export async function refreshGeminiKey(): Promise<string | null> {
  try {
    setCache(await loadGeminiKey());
  } catch (e) {
    console.error('[byok] refresh failed', e);
    setCache(null);
  }
  return cachedKey;
}

/** キーを保存し、メモリキャッシュも更新する。 */
export async function saveAndCacheGeminiKey(rawKey: string): Promise<void> {
  await saveGeminiKey(rawKey);
  setCache(rawKey);
}

/** キーを DB から削除し、メモリキャッシュも消す。 */
export async function clearAndUncacheGeminiKey(): Promise<void> {
  await clearGeminiKey();
  setCache(null);
}

/** ログアウト時などにメモリキャッシュのみクリア（DB は触らない）。 */
export function resetGeminiKeyCache(): void {
  setCache(null);
}
