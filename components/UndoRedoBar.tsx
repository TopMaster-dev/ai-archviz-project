import { useStore } from 'zustand';
import { Undo2, Redo2 } from 'lucide-react';
import { useProjectStore } from '../lib/store/projectStore.js';
import { useRenderOverlayStore } from '../lib/store/renderOverlayStore.js';

// 元に戻す / やり直す のクリック操作（キーボードの Ctrl+Z / Ctrl+Y と同じ temporal を駆動）。
// 履歴の有無でボタンの活性/非活性を切り替える。
// AI レンダリング/画像処理のオーバーレイ表示中は非表示にする（ローディング画面に被らないように）。
// ※ Ctrl+Z / Ctrl+Y のショートカットは引き続き有効（ボタンを隠すだけ）。

export function UndoRedoBar() {
  const canUndo = useStore(useProjectStore.temporal, (t) => t.pastStates.length > 0);
  const canRedo = useStore(useProjectStore.temporal, (t) => t.futureStates.length > 0);
  const overlayActive = useRenderOverlayStore((s) => s.active);
  // 上部ツールバーの実測下端の直下に配置（ヘッダーが折り返して高くなっても被らない）。
  // 未計測（0）のときは従来の 92px にフォールバック＝挙動不変。
  const headerBottom = useRenderOverlayStore((s) => s.headerBottom);
  // 2Dで作図ツールバーを最上段へ上げているとき（>0）は、そのツールバーの直下へ退避する（重なり防止）。
  const sketchToolbarBottom = useRenderOverlayStore((s) => s.sketchToolbarBottom);
  const topPx = sketchToolbarBottom > 0 ? sketchToolbarBottom + 10 : headerBottom > 0 ? headerBottom + 10 : 92;

  // 2D（作図ツールバーが上段にあるとき）はツールバー内に「一つ戻る/やり直し」を統合したため、
  // フローティングのバーは隠す（260623・重複回避）。3Dビューでは従来どおり表示する。
  if (overlayActive || sketchToolbarBottom > 0) return null;

  // 2Dツールバーと合わせてアイコン＋テキスト表記（260623）。
  const btn =
    'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-neutral-200 transition hover:bg-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div
      style={{ top: topPx }}
      className="fixed left-1/2 z-[1000] flex -translate-x-1/2 gap-1 rounded-xl bg-neutral-800/80 p-1 shadow ring-1 ring-white/10"
    >
      <button
        type="button"
        onClick={() => useProjectStore.temporal.getState().undo()}
        disabled={!canUndo}
        title="元に戻す (Ctrl+Z)"
        aria-label="元に戻す"
        className={btn}
      >
        <Undo2 className="h-4 w-4" /> 一つ戻る
      </button>
      <button
        type="button"
        onClick={() => useProjectStore.temporal.getState().redo()}
        disabled={!canRedo}
        title="やり直す (Ctrl+Y)"
        aria-label="やり直す"
        className={btn}
      >
        <Redo2 className="h-4 w-4" /> やり直し
      </button>
    </div>
  );
}
