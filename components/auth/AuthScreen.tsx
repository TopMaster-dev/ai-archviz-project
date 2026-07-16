import { useState } from 'react';
import { LoginForm } from './LoginForm.js';
import { RegistrationRequestForm } from './RegistrationRequestForm.js';
import { LandingPage } from './LandingPage.js';
import { LegalPage, type LegalKind } from './LegalPage.js';

/**
 * 認証画面。
 * 未ログイン時はまずランディングページ（サービス説明・導線）を表示し、
 * 「ログイン」でログイン/登録リクエストへ切り替える（管理表 row 37/42/62/67）。
 * 利用規約・プライバシーポリシーのページも未ログイン画面から閲覧できる（row 43。同意UIは登録画面側=row 38）。
 * #2（260716 再設計）: 招待制を維持したまま「登録リクエスト（メールのみ）」を提供。送信時に同一PC/同一メールの
 * 重複を判定し、運営が承認すると招待リンクをメール送信 → リンクから本登録（RegistrationForm）へ進む。
 */
export function AuthScreen() {
  const [view, setView] = useState<'landing' | 'login' | 'request'>('landing');
  const [legal, setLegal] = useState<LegalKind | null>(null);

  if (legal) {
    return <LegalPage kind={legal} onBack={() => setLegal(null)} />;
  }

  if (view === 'landing') {
    return <LandingPage onLogin={() => setView('login')} onShowLegal={setLegal} />;
  }

  const isRequest = view === 'request';

  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-neutral-900 px-4">
      <div className="w-full max-w-md rounded-2xl bg-neutral-800/80 p-8 shadow-xl ring-1 ring-white/10">
        <h1 className="mb-1 text-center text-2xl font-bold text-white">Arise</h1>
        <p className="mb-6 text-center text-sm text-neutral-400">建築・内装向け AI 空間デザイン</p>

        {isRequest ? <RegistrationRequestForm onGoToLogin={() => setView('login')} /> : <LoginForm />}

        <p className="mt-6 border-t border-white/10 pt-4 text-center text-[12px] leading-relaxed text-neutral-400">
          {isRequest ? 'すでにアカウントをお持ちですか？' : 'アカウントをお持ちでない方'}
          <button
            type="button"
            onClick={() => setView(isRequest ? 'login' : 'request')}
            className="ml-1.5 font-bold text-emerald-400 transition hover:text-emerald-300"
          >
            {isRequest ? 'ログイン' : '新規登録'}
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
