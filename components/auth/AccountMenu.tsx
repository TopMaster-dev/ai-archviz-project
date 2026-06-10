import { Home } from 'lucide-react';

/**
 * エディタ画面右上の「ホームに戻る」ボタン（5b）。
 * 旧・丸いアカウントアイコン（ホーム＋ログアウトのドロップダウン）を廃止し、
 * 視認性の高い明示ボタンに置き換え。ログアウトはホーム画面／設定画面に集約する。
 */
export function AccountMenu({ onHome }: { onHome?: () => void }) {
  if (!onHome) return null;
  return (
    <button
      type="button"
      onClick={onHome}
      title="ホームに戻る（プロジェクト一覧）"
      className="fixed right-4 top-[88px] z-[1001] flex items-center gap-1.5 rounded-xl bg-neutral-800/90 px-3.5 py-2 text-xs font-bold text-white shadow-xl ring-1 ring-white/10 backdrop-blur transition hover:bg-neutral-700"
    >
      <Home className="h-3.5 w-3.5" />
      ホームに戻る
    </button>
  );
}
