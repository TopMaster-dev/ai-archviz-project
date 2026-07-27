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

/**
 * BYOK（自分のAPIキー）を使わせてよいユーザーか（260728 クライアント #2）。
 *
 * 要望:「APIキーのメニューは基本『非表示』にして、特定のユーザー（＝AI API原価を開示してよい
 * NDA締結企業）にだけ開放する」。判定は運営が管理する profiles.byok_enabled のみ。
 * 未取得/未適用（undefined）は false＝非表示に倒す（deny by default）。
 *
 * メール許可リストを VITE_ 環境変数で持つ案は採らない: クライアントバンドルへNDA企業のメールが
 * 載ってしまい、隠したい情報より重い漏洩になるため。
 */
export function canUseByok(profile: { byok_enabled?: boolean | null } | null | undefined): boolean {
  return profile?.byok_enabled === true;
}

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
