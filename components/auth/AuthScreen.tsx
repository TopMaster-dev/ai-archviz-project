import { LoginForm } from './LoginForm.js';

/**
 * 認証画面。
 * Arise は招待制（管理者がアカウントを発行）のため、公開の新規登録フォームは提供しない（1c）。
 * ログインのみを表示し、登録は招待メール経由とする。
 */
export function AuthScreen() {
  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-neutral-900 px-4">
      <div className="w-full max-w-md rounded-2xl bg-neutral-800/80 p-8 shadow-xl ring-1 ring-white/10">
        <h1 className="mb-1 text-center text-2xl font-bold text-white">Arise</h1>
        <p className="mb-6 text-center text-sm text-neutral-400">建築・内装向け AI 空間デザイン</p>

        <LoginForm />

        <p className="mt-6 border-t border-white/10 pt-4 text-center text-[11px] leading-relaxed text-neutral-500">
          現在 Arise は招待制です。
          <br />
          ご利用をご希望の方は、運営からの招待メールをご確認ください。
        </p>
      </div>
    </div>
  );
}
