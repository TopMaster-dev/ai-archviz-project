// ログイン時の端末・IP 記録（管理表 row 53）。
// 端末情報を集めて /api/session-log へ送り、サーバが IP を付与して login_events へ記録する。
// ベストエフォート: 失敗してもログインフローは妨げない（呼び出し側も await/結果を見ない想定）。

const LAST_LOGIN_KEY = 'arise_last_login_signin';

function collectDeviceInfo(): Record<string, string> {
  try {
    return {
      userAgent: navigator.userAgent,
      screen: `${window.screen.width}x${window.screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
    };
  } catch {
    return {};
  }
}

/**
 * ログイン時に端末・IP を記録する（row 53・best-effort）。
 *
 * 重複防止: supabase-js はページ再読込・セッション復元・トークン更新でも SIGNED_IN を発火するため、
 * 「本当の資格情報ログインでのみ進む」last_sign_in_at をキーに localStorage で去重し、再読込時の
 * 重複記録を防ぐ（last_sign_in_at が取れない場合はトークンで代替）。失敗してもログインは妨げない。
 */
export async function recordLoginEvent(
  accessToken: string | null | undefined,
  lastSignInAt?: string | null,
): Promise<void> {
  if (!accessToken) return;
  const dedupKey = lastSignInAt || accessToken;
  try {
    // 同一ログイン（同じ last_sign_in_at）は記録済みならスキップ。先に記録して競合での二重送信も防ぐ。
    if (localStorage.getItem(LAST_LOGIN_KEY) === dedupKey) return;
    localStorage.setItem(LAST_LOGIN_KEY, dedupKey);
  } catch {
    // localStorage 不可（プライベートモード等）。去重は効かないが記録は試みる。
  }
  try {
    await fetch('/api/session-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(collectDeviceInfo()),
      keepalive: true,
    });
  } catch {
    // 監査記録の失敗は無視（ログインを妨げない）。
  }
}
