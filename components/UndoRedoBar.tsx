import { useStore } from 'zustand';
import { Undo2, Redo2 } from 'lucide-react';
import { useProjectStore } from '../lib/store/projectStore.js';

// 元に戻す / やり直す のクリック操作（キーボードの Ctrl+Z / Ctrl+Y と同じ temporal を駆動）。
// 履歴の有無でボタンの活性/非活性を切り替える。

export function UndoRedoBar() {
  const canUndo = useStore(useProjectStore.temporal, (t) => t.pastStates.length > 0);
  const canRedo = useStore(useProjectStore.temporal, (t) => t.futureStates.length > 0);

  const btn =
    'flex h-8 w-8 items-center justify-center rounded-lg text-neutral-200 transition hover:bg-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div className="fixed top-[68px] left-1/2 z-[1000] flex -translate-x-1/2 gap-1 rounded-xl bg-neutral-800/80 p-1 shadow ring-1 ring-white/10">
      <button
        type="button"
        onClick={() => useProjectStore.temporal.getState().undo()}
        disabled={!canUndo}
        title="元に戻す (Ctrl+Z)"
        aria-label="元に戻す"
        className={btn}
      >
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => useProjectStore.temporal.getState().redo()}
        disabled={!canRedo}
        title="やり直す (Ctrl+Y)"
        aria-label="やり直す"
        className={btn}
      >
        <Redo2 className="h-4 w-4" />
      </button>
    </div>
  );
}
