import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { HomeScreen } from '../HomeScreen.js';
import { ProjectSaveIndicator } from '../ProjectSaveIndicator.js';
import { UndoRedoBar } from '../UndoRedoBar.js';
import { ShellNavProvider } from '../../lib/shell/shellNavContext.js';
import { useProjectSessionContext } from '../../lib/project/projectSessionContext.js';
import { LoadingOverlay } from '../LoadingOverlay.js';
import { EyedropperOverlay } from '../EyedropperOverlay.js';
import { useLoadingStore } from '../../lib/store/loadingStore.js';

/**
 * ログイン後のシェル。ホーム画面（プロジェクト管理）とエディタ（2D/3D）を切り替える。
 * - 既定はホーム画面。プロジェクトを「開く」と entered=true でエディタを表示。
 * - エディタからは右上メニューの「ホーム」で戻れる。戻る際は離脱時オートセーブ（flushSave）を
 *   実行して確実に保存してから遷移する（編集内容の取りこぼし防止）。
 * - 保存に失敗したときは遷移せず、再試行／保存せずに戻る を選べるようにする（黙って離脱して
 *   未保存の変更を失わないため）。
 * ※ ProjectSessionProvider の内側で使用すること（ホーム・エディタで同一セッションを共有）。
 */
export function AuthedShell({ children }: { children: ReactNode }) {
  const session = useProjectSessionContext();
  const [entered, setEntered] = useState(false);
  const [leavingHome, setLeavingHome] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // ホームへ戻る前にオートセーブをフラッシュ（即時保存して完了を待つ）してから遷移する。
  // 保存成功時のみ遷移し、失敗時はエディタに留まってエラーを提示する（データ保全を優先）。
  const goHome = useCallback(async () => {
    if (leavingHome) return;
    setLeavingHome(true);
    setSaveError(false);
    try {
      await session.flushSave();
      setEntered(false);
    } catch {
      // 保存できなかった以上、黙って遷移すると未保存の変更を失う。留まって再試行を促す。
      setSaveError(true);
    } finally {
      setLeavingHome(false);
    }
  }, [leavingHome, session]);

  // 保存に失敗したが、それでもホームへ戻る（未保存の変更を破棄する）明示的な操作。
  const leaveWithoutSaving = useCallback(() => {
    setSaveError(false);
    setEntered(false);
  }, []);

  // 失敗後に編集を続け、その後の autosave が成功した場合はエラー提示を自動で取り下げる
  // （実際には保存できているのに「保存に失敗しました」が残り続けないように）。
  useEffect(() => {
    if (session.status === 'ready') setSaveError(false);
  }, [session.status]);

  // 複製・プロジェクト切替などの非同期処理中はローディング・オーバーレイを表示（260630・クライアント要望）。
  // 速い処理でのちらつきを避けるため、250ms 以上かかる場合のみ表示する（複製は AI画像再アップロードで重い）。
  useEffect(() => {
    if (!session.busy) {
      useLoadingStore.getState().hide('session');
      return;
    }
    const t = window.setTimeout(() => useLoadingStore.getState().show('session', '処理しています…'), 250);
    return () => {
      window.clearTimeout(t);
      useLoadingStore.getState().hide('session');
    };
  }, [session.busy]);

  if (!entered) {
    return (
      <>
        <LoadingOverlay />
        <HomeScreen onEnter={() => setEntered(true)} />
      </>
    );
  }

  return (
    <ShellNavProvider goHome={goHome} homeBusy={leavingHome}>
      {children}
      <LoadingOverlay />
      {/* アプリ内スポイト（3D画面/画像から色取得）のオーバーレイ。エディタ全体で常設（260709）。 */}
      <EyedropperOverlay />
      {/* 「ホームに戻る」は 2D/3D/AI 各ビューの ModeToggleBar 左端に統一（260623）。右上固定ボタンは廃止。 */}
      <ProjectSaveIndicator />
      <UndoRedoBar />
      {saveError && (
        // 写真AIオーバーレイ（z-10000）よりも前面に出すため z-[10001]。両モードで見えるよう上部中央に表示。
        <div className="fixed left-1/2 top-4 z-[10001] w-[min(92vw,28rem)] -translate-x-1/2 rounded-xl border border-red-400/30 bg-red-950/95 p-3.5 text-xs text-red-50 shadow-2xl ring-1 ring-black/20 backdrop-blur">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
            <div className="flex-1">
              <p className="font-bold">保存に失敗しました</p>
              <p className="mt-1 text-red-200/90">
                ネットワーク状況をご確認のうえ、もう一度お試しください。編集内容はまだ画面に残っています。
              </p>
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={goHome}
                  disabled={leavingHome}
                  className="rounded-lg bg-white px-3 py-1.5 font-bold text-red-950 transition hover:bg-red-50 disabled:opacity-60"
                >
                  {leavingHome ? '保存中…' : '再試行'}
                </button>
                <button
                  type="button"
                  onClick={leaveWithoutSaving}
                  disabled={leavingHome}
                  className="rounded-lg bg-white/10 px-3 py-1.5 font-semibold text-red-100 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-60"
                >
                  保存せずに戻る
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ShellNavProvider>
  );
}
