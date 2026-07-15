import { useState } from 'react';
import { LoginForm } from './LoginForm.js';
import { SignupForm } from './SignupForm.js';
import { LandingPage } from './LandingPage.js';
import { LegalPage, type LegalKind } from './LegalPage.js';

/**
 * 認証画面。
 * 未ログイン時はまずランディングページ（サービス説明・導線）を表示し、
 * 「ログイン」でログイン/新規登録フォームへ切り替える（管理表 row 37/42/62/67）。
 * 利用規約・プライバシーポリシーのページも未ログイン画面から閲覧できる（row 43。同意UIは登録画面側=row 38）。
 * #2（260715）: 公開の新規登録を提供し、登録時に「同一PCでの再登録」を判定してブロックする
 * （サーバ側フラグ ENABLE_REREG_DEVICE_BLOCK が有効なとき。Supabase の公開サインアップ有効化が前提）。
 */
export function AuthScreen() {
  const [view, setView] = useState<'landing' | 'login' | 'signup'>('landing');
  const [legal, setLegal] = useState<LegalKind | null>(null);

  if (legal) {
    return <LegalPage kind={legal} onBack={() => setLegal(null)} />;
  }

  if (view === 'landing') {
    return <LandingPage onLogin={() => setView('login')} onShowLegal={setLegal} />;
  }

  const isSignup = view === 'signup';

  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-neutral-900 px-4">
      <div className="w-full max-w-md rounded-2xl bg-neutral-800/80 p-8 shadow-xl ring-1 ring-white/10">
        <h1 className="mb-1 text-center text-2xl font-bold text-white">Arise</h1>
        <p className="mb-6 text-center text-sm text-neutral-400">建築・内装向け AI 空間デザイン</p>

        {isSignup ? <SignupForm onGoToLogin={() => setView('login')} /> : <LoginForm />}

        <p className="mt-6 border-t border-white/10 pt-4 text-center text-[12px] leading-relaxed text-neutral-400">
          {isSignup ? 'すでにアカウントをお持ちですか？' : 'アカウントをお持ちでない方'}
          <button
            type="button"
            onClick={() => setView(isSignup ? 'login' : 'signup')}
            className="ml-1.5 font-bold text-emerald-400 transition hover:text-emerald-300"
          >
            {isSignup ? 'ログイン' : '新規登録'}
          </button>
        </p>

        <div className="mt-3 flex items-center justify-center gap-3 text-[11px] text-neutral-500">
          <button type="button" onClick={() => setLegal('terms')} className="transition hover:text-neutral-300">
            利用規約
          </button>
          <span className="text-neutral-700">/</span>
          <button type="button" onClick={() => setLegal('privacy')} className="transition hover:text-neutral-300">
            プライバシーポリシー
          </button>
        </div>

        <button
          type="button"
          onClick={() => setView('landing')}
          className="mt-4 block w-full text-center text-[11px] text-neutral-500 transition hover:text-neutral-300"
        >
          ← トップへ戻る
        </button>
      </div>
    </div>
  );
}
