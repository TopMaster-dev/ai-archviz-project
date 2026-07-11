/**
 * 管理ダッシュボードのアクセス許可（メール許可リスト・純関数・260711）。
 * 運営は env `ADMIN_EMAILS`（カンマ区切り）に自分のログインメールを設定する。未設定=誰も管理者でない（deny-all＝安全既定）。
 * サーバー側で「ログイン中ユーザーの検証済みメール」を許可リストと突き合わせて判定する（値の検証は別途 service_role で getUser）。
 * ここは外部依存のない純関数のみ（ユニットテスト可能）。
 */

/** env の許可リスト文字列を、正規化（小文字・トリム・空除去）した配列にする。 */
export function parseAdminEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 検証済みメールが許可リストに含まれるか（大文字小文字・前後空白を無視）。 */
export function isAdminEmail(email: string | null | undefined, allowlist: string[]): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!e) return false;
  return allowlist.includes(e);
}
