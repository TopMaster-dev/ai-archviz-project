import { useProjectSessionContext } from '../lib/project/projectSessionContext.js';

// プロジェクトの読み込み/保存ステータスを表示する。autosave セッション本体は
// ProjectSessionProvider が起動し、その状態をここで購読する（ストアは singleton で共有）。

const LABELS: Record<string, string> = {
  loading: '読み込み中…',
  saving: '保存中…',
  ready: '保存済み',
  error: '保存エラー',
};

export function ProjectSaveIndicator() {
  const { status } = useProjectSessionContext();
  if (status === 'idle') return null;

  const label = LABELS[status] ?? '';
  const color =
    status === 'error'
      ? 'text-red-300'
      : status === 'saving' || status === 'loading'
        ? 'text-amber-300'
        : 'text-emerald-300';

  return (
    <div className="fixed left-3 top-3 z-[1000] rounded-full bg-neutral-800/80 px-3 py-1 text-[11px] shadow ring-1 ring-white/10">
      <span className={color}>{label}</span>
    </div>
  );
}
