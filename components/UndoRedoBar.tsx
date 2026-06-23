import { useStore } from 'zustand';
import { Undo2, Redo2 } from 'lucide-react';
import { useProjectStore } from '../lib/store/projectStore.js';
import { useRenderOverlayStore } from '../lib/store/renderOverlayStore.js';

// 元に戻す / やり直す（キーボードの Ctrl+Z / Ctrl+Y と同じ temporal を駆動）。
// inline=false（既定・フローティング）: App の外側に固定配置。AIオーバーレイ中／2Dツールバー統合中／
//   3Dヘッダーのインライン表示中（undoRedoInline）は隠す。
// inline=true: 3Dビューのヘッダー行内に配置（フローティングしない・260623）。
export function UndoRedoBar({ inline = false }: { inline?: boolean }) {
  const canUndo = useStore(useProjectStore.temporal, (t) => t.pastStates.length > 0);
  const canRedo = useStore(useProjectStore.temporal, (t) => t.futureStates.length > 0);
  const overlayActive = useRenderOverlayStore((s) => s.active);
  const headerBottom = useRenderOverlayStore((s) => s.headerBottom);
  const sketchToolbarBottom = useRenderOverlayStore((s) => s.sketchToolbarBottom);
  const undoRedoInline = useRenderOverlayStore((s) => s.undoRedoInline);
  const topPx = sketchToolbarBottom > 0 ? sketchToolbarBottom + 10 : headerBottom > 0 ? headerBottom + 10 : 92;

  // フローティング版は、2Dツールバー統合中・3Dヘッダーのインライン表示中・オーバーレイ中は隠す。
  if (!inline && (overlayActive || sketchToolbarBottom > 0 || undoRedoInline)) return null;

  // 2Dツールバーと合わせてアイコン＋テキスト表記（260623）。
  const btn =
    'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-neutral-200 transition hover:bg-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent';

  const buttons = (
    <>
      <button
        type="button"
        onClick={() => useProjectStore.temporal.getState().undo()}
        disabled={!canUndo}
        title="元に戻す (Ctrl+Z)"
        aria-label="元に戻す"
        className={btn}
      >
        一つ戻る <Undo2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => useProjectStore.temporal.getState().redo()}
        disabled={!canRedo}
        title="やり直す (Ctrl+Y)"
        aria-label="やり直す"
        className={btn}
      >
        やり直し <Redo2 className="h-4 w-4" />
      </button>
    </>
  );

  if (inline) {
    return (
      <div className="pointer-events-auto flex h-[46px] shrink-0 items-center gap-1 rounded-2xl border border-white/10 bg-black/40 p-1.5 shadow-xl backdrop-blur-md">
        {buttons}
      </div>
    );
  }

  return (
    <div
      style={{ top: topPx }}
      className="fixed left-1/2 z-[1000] flex -translate-x-1/2 gap-1 rounded-xl bg-neutral-800/80 p-1 shadow ring-1 ring-white/10"
    >
      {buttons}
    </div>
  );
}
