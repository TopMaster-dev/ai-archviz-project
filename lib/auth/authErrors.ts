// Supabase 認証のエラーメッセージを、ユーザー向けの日本語に変換する。
// 未知のメッセージは原文のまま返す（情報を失わないため）。

const ERROR_MAP: Array<{ test: RegExp; message: string }> = [
  {
    test: /email not confirmed/i,
    message: 'メールアドレスが未確認です。受信した確認メールのリンクから登録を完了してください。',
  },
  {
    test: /invalid login credentials/i,
    message: 'メールアドレスまたはパスワードが正しくありません。',
  },
  {
    test: /(user )?already registered/i,
    message: 'このメールアドレスは既に登録されています。',
  },
  {
    test: /password should be at least/i,
    message: 'パスワードは8文字以上で設定してください。',
  },
  {
    test: /(unable to validate email address|invalid email)/i,
    message: 'メールアドレスの形式が正しくありません。',
  },
  {
    test: /(rate limit|too many requests)/i,
    message: 'リクエストが多すぎます。しばらく時間をおいて再度お試しください。',
  },
];

export function translateAuthError(raw: string): string {
  for (const { test, message } of ERROR_MAP) {
    if (test.test(raw)) return message;
  }
  return raw;
}
