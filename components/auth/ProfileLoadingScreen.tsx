import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * ログイン済みだがプロフィール未取得のときの読み込み画面。
 *
 * 通常は handle_new_user トリガが profiles 行を必ず作成するため一瞬で解消するが、
 * スキーマ/トリガが本番DBに未適用だと profiles 行が存在せず loadProfile が null を返し続け、
 * 「読み込み中…」のまま固まって「アプリが開かない」ように見える（招待フローの落とし穴）。
 *
 * そこで一定時間（SLOW_AFTER_MS）経過しても解消しない場合は、無限スピナーではなく
 * 原因の案内と「再読み込み」「ログアウト」の操作を提示し、ユーザーが復帰できるようにする。
 * プロフィールが取得できた時点で AuthGate 側が本コンポーネントをアンマウントする。
 */
const SLOW_AFTER_MS = 8000;

export function ProfileLoadingScreen() {
  const { refreshProfile, signOut } = useAuth();
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setSlow(false);
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [attempt]);

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-5 bg-neutral-900 px-6 text-neutral-300">
      <div className="text-sm">読み込み中…</div>

      {slow && (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-xs leading-relaxed text-neutral-400">
            プロフィールの読み込みに時間がかかっています。通信状況をご確認のうえ再読み込みしてください。
            問題が続く場合は、一度ログアウトして再度ログイン（または招待メールのリンク）をお試しください。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void refreshProfile();
                setAttempt((a) => a + 1);
              }}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500"
            >
              再読み込み
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-white/15 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-white/30 hover:text-white"
            >
              ログアウト
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
