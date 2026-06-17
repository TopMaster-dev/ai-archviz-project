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

/** メールアドレスの変更を要求（新アドレスへ確認リンクが届くまで反映されない）。 */
export async function updateEmail(email: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、メールを変更できません。');
  const { error } = await sb.auth.updateUser({ email });
  if (error) throw error;
}

/** パスワードの変更（ログイン中のセッションで実行）。 */
export async function updatePassword(password: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase が未構成のため、パスワードを変更できません。');
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
}
