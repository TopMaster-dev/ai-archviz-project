import { useState } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * ログイン中のアカウント表示 + ログアウト。
 * ※暫定的に画面右上の固定チップとして表示する。状態リファクタ後にアプリのヘッダーへ統合予定。
 */
export function AccountMenu() {
  const { email, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const initial = (email ?? '?').charAt(0).toUpperCase();

  return (
    <div className="fixed right-2 top-2 z-[1000] text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={email ?? 'アカウント'}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 font-semibold text-white shadow ring-1 ring-black/20 transition hover:bg-emerald-500"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-lg bg-neutral-800 p-3 text-neutral-200 shadow-xl ring-1 ring-white/10">
          <p className="mb-2 truncate text-[11px] text-neutral-400" title={email ?? ''}>
            {email ?? 'ログイン中'}
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="w-full rounded-md bg-neutral-700/70 py-1.5 text-center transition hover:bg-neutral-700"
          >
            ログアウト
          </button>
        </div>
      )}
    </div>
  );
}
