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
    // 記録済みの同一ログイン（同じ last_sign_in_at）はスキップ。
    if (localStorage.getItem(LAST_LOGIN_KEY) === dedupKey) return;
  } catch {
    // localStorage 不可（プライベートモード等）。去重は効かないが記録は試みる。
  }
  try {
    const res = await fetch('/api/session-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(collectDeviceInfo()),
      keepalive: true,
    });
    // 実際に記録できたときだけ去重キーを保存する。キー未設定でスキップ/失敗した場合は保存せず、
    // 次回ログインで再試行できるようにする（設定前の試行で去重が汚染されるのを防ぐ）。
    const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
    if (data?.success) {
      try {
        localStorage.setItem(LAST_LOGIN_KEY, dedupKey);
      } catch {
        /* 保存不可は無視 */
      }
    }
  } catch {
    // 監査記録の失敗は無視（ログインを妨げない）。
  }
}

/**
 * #2（260715）: 新規登録の前に、この端末（PC）で既に別アカウントが登録済みかをサーバへ問い合わせる。
 * トークン不要（まだアカウントが無いため）。サーバ側フラグ ENABLE_REREG_DEVICE_BLOCK=true のときのみ判定し、
 * それ以外・失敗・情報不足は blocked:false を返す（フェイルオープン＝正当な登録を妨げない）。
 */
export async function checkDeviceForReregistration(): Promise<{ blocked: boolean; reason?: string }> {
  try {
    const res = await fetch('/api/session-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'check-device', ...collectDeviceInfo() }),
    });
    const data = (await res.json().catch(() => null)) as { blocked?: boolean; reason?: string } | null;
    return { blocked: !!data?.blocked, reason: data?.reason };
  } catch {
    return { blocked: false, reason: 'network-error' };
  }
}

/**
 * #2 再設計（260716）: 登録リクエストを送信する（トークン不要）。メールのみ＋端末情報を送り、サーバ側で
 * 重複（同一メール/同一PC）を判定する。blocked=重複でブロック、ok=リクエスト受付、それ以外は失敗（reason）。
 */
export async function submitRegistrationRequest(
  email: string,
): Promise<{ ok: boolean; blocked?: boolean; reason?: string }> {
  try {
    const res = await fetch('/api/session-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'registration-request', email, ...collectDeviceInfo() }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; blocked?: boolean; reason?: string } | null;
    if (data?.blocked) return { ok: false, blocked: true, reason: data.reason };
    return { ok: !!data?.ok, reason: data?.reason };
  } catch {
    return { ok: false, reason: 'network-error' };
  }
}
