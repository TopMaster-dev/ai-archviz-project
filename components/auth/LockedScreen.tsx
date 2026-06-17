import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * アカウントロック画面（管理表 row 54）。
 * profiles.locked_at が設定されたアカウント（自動検知 or 管理者）に表示し、アプリ利用を停止する。
 * 自己解除はできない（解除は運営/管理者が DB 側で locked_at を null に戻す）。
 */
export function LockedScreen() {
  const { email, signOut } = useAuth();
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-neutral-950 px-6 text-neutral-100">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-bold text-amber-300">アカウントが一時停止されています</h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          ご利用のアカウントは、不正利用防止のため一時的に停止されています。
          心当たりがない場合やご利用を再開したい場合は、お手数ですが運営までお問い合わせください。
        </p>
        {email && <p className="mt-4 rounded-lg bg-neutral-800/60 px-3 py-2 text-xs text-neutral-300">対象アカウント：{email}</p>}
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 rounded-lg border border-white/15 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-white/30 hover:text-white"
        >
          ログアウト
        </button>
      </div>
    </div>
  );
}
