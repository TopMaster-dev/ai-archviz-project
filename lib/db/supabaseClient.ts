import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Supabase（認証 + Postgres）クライアント。
// 環境変数が未設定の場合は null を返し、アプリは「ゲスト/ローカルモード」で従来どおり動作する
// （ローカル開発で Supabase を立てずに 2D/3D/AI 編集を確認できるようにするため）。

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Supabase が環境変数で構成済みか。false ならゲストモード（認証ゲートなし）。 */
export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

/**
 * Storage への直接 XHR アップロード（進捗取得）で必要な URL / anon キー。
 * 未構成なら null（呼び出し側は SDK アップロード＝進捗なしにフォールバック）。
 */
export function getSupabaseConfig(): { url: string; anonKey: string } | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}

let client: SupabaseClient | null = null;

/** 構成済みなら Supabase クライアント（シングルトン）を返す。未構成なら null。 */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}
