import { useState } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { RegistrationForm } from './RegistrationForm.js';
import { LegalPage } from './LegalPage.js';
import type { LegalKind } from './LegalPage.js';

/**
 * 招待制の本登録画面（管理表 row 38）。
 *
 * 招待 → ログイン済みだが本登録未完了（profiles.registered_at が NULL）のユーザーに対し、
 * AuthGate がアプリ本体の代わりに本画面を表示する。属性入力・規約同意の確定後は
 * AuthContext が profile を再読込し、AuthGate が自動でアプリへ遷移する。
 *
 * スクロール: #root が overflow:hidden のため、本画面は h-screen + overflow-y-auto で
 * 内部スクロールさせる（ランディング/規約ページと同方針）。
 */
export function RegistrationScreen() {
  const { email, signOut } = useAuth();
  const [legal, setLegal] = useState<LegalKind | null>(null);

  if (legal) {
    return <LegalPage kind={legal} onBack={() => setLegal(null)} />;
  }

  return (
    <div className="h-screen w-screen overflow-y-auto bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-lg px-6 py-12 sm:py-16">
        <div className="mb-6 flex items-baseline gap-2">
          <span className="text-xl font-black tracking-tight">Arise</span>
          <span className="text-[11px] text-neutral-500">建築・内装向け AI 空間デザイン</span>
        </div>

        <div className="rounded-2xl border border-white/10 bg-neutral-900/50 p-6 sm:p-8">
          <h1 className="text-lg font-bold">本登録のご案内</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-neutral-400">
            Arise へようこそ。ご利用を開始するため、以下の情報をご登録ください。
            ご登録いただいた内容は、いつでもアカウント設定から変更できます。
          </p>
          {email && (
            <p className="mt-3 rounded-lg bg-neutral-800/60 px-3 py-2 text-xs text-neutral-300">
              ログイン中のアカウント：<span className="font-semibold text-neutral-100">{email}</span>
            </p>
          )}

          <div className="mt-5">
            <RegistrationForm onShowLegal={setLegal} />
          </div>

          <div className="mt-5 border-t border-white/5 pt-4 text-center">
            <button
              type="button"
              onClick={() => void signOut()}
              className="text-xs text-neutral-500 transition hover:text-neutral-300"
            >
              別のアカウントでログインする
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
