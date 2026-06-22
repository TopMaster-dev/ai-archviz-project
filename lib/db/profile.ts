import { getSupabase } from './supabaseClient.js';
import type { UserRole } from './types.js';

// プロフィール（profiles テーブル）と認証情報（メール/パスワード）の更新。
// RLS は本人のみ。メール変更は Supabase の確認リンク方式（即時には反映されない）。

/**
 * profiles 行の更新パッチ（本人のみ更新可）。設定変更・招待後の本登録の双方で使用する。
 * registered_at / terms_accepted_at は本登録の確定時に呼び出し側でタイムスタンプを入れる。
 */
export interface ProfilePatch {
  role?: UserRole;
  display_name?: string | null;
  phone?: string | null;
  company?: string | null;
  graduation_year?: number | null;
  department?: string | null;
  school_year?: string | null;
  registered_at?: string | null;
  terms_accepted_at?: string | null;
}

/** profiles 行の更新（本人のみ）。属性変更・本登録の確定に使用。 */
export async function updateProfile(patch: ProfilePatch): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、プロフィールを更新できません。');
  const { data: u } = await sb.auth.getUser();
  const uid = u.user?.id;
  if (!uid) throw new Error('未ログインのため、プロフィールを更新できません。');
  const { error } = await sb.from('profiles').update(patch).eq('id', uid);
  if (error) throw error;
}

/**
 * メールアドレスの変更を要求（確認リンクをクリックするまで反映されない）。
 * 確認リンクのリダイレクト先をアプリ自身に明示する（Supabase の Site URL 任せにしない）。
 * Supabase の検証はリダイレクト先が許可リスト（URL Configuration の Redirect URLs）に
 * 含まれないと失敗し、リンクを踏んでも反映されないため、現在のアプリ URL を渡す。
 * ※ Supabase 側「Secure email change」が有効な場合は、現在のアドレスと新しいアドレスの
 *   両方に確認メールが届き、両方をクリックするまで反映されない（260623 不具合の主因はここの可能性）。
 */
export async function updateEmail(email: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、メールを変更できません。');
  const emailRedirectTo =
    typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : undefined;
  const { error } = await sb.auth.updateUser(
    { email },
    emailRedirectTo ? { emailRedirectTo } : undefined,
  );
  if (error) throw error;
}

/** パスワードの変更（ログイン中のセッションで実行）。 */
export async function updatePassword(password: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、パスワードを変更できません。');
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
}
