import { getSupabase } from '../db/supabaseClient.js';

/**
 * 管理ダッシュボードのクライアント補助（260713）。UI の出し分け（管理者だけに「運営」ボタンを見せる）と、
 * ダッシュボードの開閉（`?admin` の付け外し）に使う。
 *
 * 管理者判定はサーバー（/api/admin/orphan-cleanup?action=whoami）が ADMIN_EMAILS 許可リストで行う。
 * クライアントは許可リストを一切持たない（＝フロントに管理者メールを埋め込まない）。whoami は未認証・非管理者
 * でも 200 で { isAdmin:false } を返すため、誰が呼んでも安全（機微情報は返らない）。
 */

/** ログイン中ユーザーが管理者か（UIの出し分け用）。失敗・未ログインは false。 */
export async function fetchIsAdmin(): Promise<boolean> {
  try {
    const sb = getSupabase();
    const token = sb ? (await sb.auth.getSession()).data.session?.access_token : null;
    if (!token) return false;
    const res = await fetch('/api/admin/orphan-cleanup?action=whoami', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data?.isAdmin;
  } catch {
    return false;
  }
}

/** 運営ダッシュボードを開く（`?admin` を付けて再読込＝index.tsx が読込時に判定して描画する）。 */
export function openAdminDashboard(): void {
  const { origin, pathname } = window.location;
  window.location.assign(`${origin}${pathname}?admin`);
}

/** 運営ダッシュボードから通常アプリ（ホーム）へ戻る（`?admin` を外して再読込）。 */
export function exitAdminDashboard(): void {
  const { origin, pathname } = window.location;
  window.location.assign(`${origin}${pathname}`);
}
