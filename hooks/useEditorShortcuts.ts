import { useEffect } from 'react';
import { useProjectStore } from '../lib/store/projectStore.js';

// エディタのキーボードショートカット:
//   Ctrl/Cmd+Z         … Undo
//   Ctrl/Cmd+Shift+Z   … Redo（Ctrl+Y も可）
//   Ctrl/Cmd+G         … 選択オブジェクトをグループ化
// 入力欄（input/textarea/contentEditable）にフォーカス中は無効。

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

export function useEditorShortcuts(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (isTyping(e.target)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useProjectStore.temporal.getState().undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        useProjectStore.temporal.getState().redo();
      } else if (key === 'g') {
        e.preventDefault();
        useProjectStore.getState().groupSelection();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
