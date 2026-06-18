import { Home, Loader2 } from 'lucide-react';
import { useRenderOverlayStore } from '../../lib/store/renderOverlayStore.js';

/**
 * エディタ画面右上の「ホームに戻る」ボタン（5b）。
 * 旧・丸いアカウントアイコン（ホーム＋ログアウトのドロップダウン）を廃止し、
 * 視認性の高い明示ボタンに置き換え。ログアウトはホーム画面／設定画面に集約する。
 *
 * saving=true（離脱時オートセーブ中）は「保存中…」を表示してボタンを無効化し、
 * 保存が終わってから安全にホームへ遷移する（二重押し防止）。
 *
 * 2Dで作図ツールバーを最上段へ上げているとき（sketchToolbarBottom>0）は、そのツールバーの直下へ退避する
 * （最上段ツールバーと重ならないように）。それ以外は従来どおり top:88px。
 */
export function AccountMenu({ onHome, saving }: { onHome?: () => void; saving?: boolean }) {
  const sketchToolbarBottom = useRenderOverlayStore((s) => s.sketchToolbarBottom);
  if (!onHome) return null;
  return (
    <button
      type="button"
      onClick={onHome}
      disabled={saving}
      title="ホームに戻る（プロジェクト一覧）"
      style={{ top: sketchToolbarBottom > 0 ? sketchToolbarBottom + 10 : 88 }}
      className="fixed right-4 z-[1001] flex items-center gap-1.5 rounded-xl bg-neutral-800/90 px-3.5 py-2 text-xs font-bold text-white shadow-xl ring-1 ring-white/10 backdrop-blur transition hover:bg-neutral-700 disabled:opacity-70 disabled:hover:bg-neutral-800/90"
    >
      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Home className="h-3.5 w-3.5" />}
      {saving ? '保存中…' : 'ホームに戻る'}
    </button>
  );
}
