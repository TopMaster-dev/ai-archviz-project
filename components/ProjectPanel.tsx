import { useEffect, useState } from 'react';
import { useProjectSessionContext } from '../lib/project/projectSessionContext.js';
import { useConfirm } from './ConfirmDialog.js';

/**
 * プロジェクト管理 UI（アカウントメニュー内に表示）。
 * 一覧・切替・新規作成・複製・改名・削除と、フリープランの保存上限表示を扱う。
 */
export function ProjectPanel() {
  const {
    projectId,
    projectName,
    projects,
    plan,
    projectCount,
    projectLimit,
    atLimit,
    busy,
    error,
    switchProject,
    createNewProject,
    duplicateCurrentProject,
    renameCurrentProject,
    deleteCurrentProject,
  } = useProjectSessionContext();
  const confirm = useConfirm();

  const [nameDraft, setNameDraft] = useState(projectName);
  const [renaming, setRenaming] = useState(false);

  // 切替などで現在プロジェクト名が変わったら（改名入力中でなければ）下書きを同期。
  useEffect(() => {
    if (!renaming) setNameDraft(projectName);
  }, [projectName, renaming]);

  const usage = plan === 'free' ? `${projectCount} / ${projectLimit}` : `${projectCount}`;

  const commitRename = () => {
    setRenaming(false);
    void renameCurrentProject(nameDraft);
  };

  return (
    <div className="mb-3 rounded-md bg-neutral-900/60 p-2">
      <div className="mb-1 flex items-center justify-between">
        <p className="font-semibold text-neutral-300">プロジェクト</p>
        <span className="text-[10px] text-neutral-500" title="保存件数">
          {usage}
        </span>
      </div>

      {/* 現在プロジェクトの改名 */}
      <input
        value={nameDraft}
        onChange={(e) => {
          setRenaming(true);
          setNameDraft(e.target.value);
        }}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        disabled={busy || !projectId}
        placeholder="プロジェクト名"
        className="mb-1.5 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-emerald-500 disabled:opacity-50"
      />

      {/* 一覧（クリックで切替） */}
      {projects.length > 0 && (
        <div className="mb-1.5 max-h-28 space-y-0.5 overflow-y-auto">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              onClick={() => void switchProject(p.id)}
              className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] transition disabled:opacity-50 ${
                p.id === projectId
                  ? 'bg-emerald-600/20 text-emerald-200'
                  : 'text-neutral-300 hover:bg-neutral-700/60'
              }`}
            >
              <span className="truncate">{p.name}</span>
              {p.id === projectId && <span className="ml-1 shrink-0">✓</span>}
            </button>
          ))}
        </div>
      )}

      {/* 操作 */}
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy || atLimit}
          onClick={() => void createNewProject()}
          title={atLimit ? 'フリープランの保存上限に達しています' : '新しいプロジェクトを作成'}
          className="flex-1 rounded bg-emerald-600 py-1 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          新規
        </button>
        <button
          type="button"
          disabled={busy || !projectId}
          onClick={() => void duplicateCurrentProject()}
          className="flex-1 rounded bg-neutral-700 py-1 transition hover:bg-neutral-600 disabled:opacity-50"
        >
          複製
        </button>
        <button
          type="button"
          disabled={busy || projects.length <= 1}
          onClick={async () => {
            if (
              await confirm({
                message: 'このプロジェクトを削除しますか？（14日間は復元可能）',
                confirmLabel: '削除',
                danger: true,
              })
            ) {
              void deleteCurrentProject();
            }
          }}
          title={projects.length <= 1 ? '最後のプロジェクトは削除できません' : 'このプロジェクトを削除'}
          className="rounded bg-neutral-700 px-2 py-1 transition hover:bg-red-700/70 disabled:opacity-50"
        >
          削除
        </button>
      </div>

      {atLimit && (
        <p className="mt-1.5 text-[10px] leading-snug text-amber-300/90">
          フリープランの保存上限（{projectLimit}件）に達しました。不要なプロジェクトを削除してください。
        </p>
      )}
      {error && <p className="mt-1.5 text-[10px] leading-snug text-red-300">{error}</p>}
    </div>
  );
}
