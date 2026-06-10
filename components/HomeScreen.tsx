import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { useAuth } from '../lib/auth/AuthContext.js';
import { useProjectSessionContext } from '../lib/project/projectSessionContext.js';
import { ByokKeyPanel } from './ByokKeyPanel.js';
import { UploadPanel } from './UploadPanel.js';
import { SettingsModal } from './SettingsModal.js';

/**
 * ログインと2Dスケッチ（エディタ）の間に表示する独立した「ホーム画面」。
 * プロジェクトの一覧/選択/作成/複製/改名/削除、Gemini APIキー設定、ログアウトを集約する。
 * 「開く」でエディタへ遷移する（onEnter）。
 */
export function HomeScreen({ onEnter }: { onEnter: () => void }) {
  const { email, signOut } = useAuth();
  const {
    projects,
    projectId,
    projectName,
    plan,
    projectCount,
    projectLimit,
    atLimit,
    busy,
    error,
    status,
    switchProject,
    createNewProject,
    duplicateCurrentProject,
    deleteCurrentProject,
    renameCurrentProject,
  } = useProjectSessionContext();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);
  // 新規作成: まず名前を入力してから遷移（2c-iii）。
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('マイプロジェクト');
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!renaming) setNameDraft(projectName);
  }, [projectName, renaming]);

  const usage = plan === 'free' ? `${projectCount} / ${projectLimit}` : `${projectCount}`;

  const openProject = async (id: string) => {
    if (id !== projectId) await switchProject(id);
    onEnter();
  };
  const confirmCreate = async () => {
    const name = newName.trim() || 'マイプロジェクト';
    setCreatingNew(false);
    await createNewProject(name);
    onEnter();
  };

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  return (
    <div className="min-h-screen w-screen overflow-y-auto bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">Arise</h1>
          <p className="text-[11px] text-neutral-400">建築・内装向け AI 空間デザイン</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="hidden text-neutral-400 sm:inline" title={email ?? ''}>
            {email}
          </span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="設定（プロフィール・APIキー）"
            aria-label="設定"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-800 text-neutral-300 transition hover:bg-neutral-700 hover:text-white"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-md bg-neutral-800 px-3 py-1.5 transition hover:bg-neutral-700"
          >
            ログアウト
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              プロジェクト
              <span className="ml-2 text-xs font-normal text-neutral-500" title="保存件数">
                {usage}
              </span>
            </h2>
            <button
              type="button"
              onClick={() => { setNewName('マイプロジェクト'); setCreatingNew(true); }}
              disabled={busy || atLimit}
              title={atLimit ? 'フリープランの保存上限に達しています' : '新しいプロジェクトを作成して開く'}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              ＋ 新規作成
            </button>
          </div>

          {atLimit && (
            <p className="mb-2 text-xs text-amber-300">
              フリープランの保存上限（{projectLimit}件）に達しました。不要なプロジェクトを削除してください。
            </p>
          )}
          {error && <p className="mb-2 text-xs text-red-300">{error}</p>}

          {status === 'loading' && projects.length === 0 ? (
            <p className="text-sm text-neutral-500">読み込み中…</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-neutral-500">
              プロジェクトがありません。「＋ 新規作成」から始めてください。
            </p>
          ) : (
            <ul className="space-y-2">
              {projects.map((p) => {
                const active = p.id === projectId;
                return (
                  <li
                    key={p.id}
                    className={`rounded-xl border p-3 transition ${
                      active
                        ? 'border-emerald-500/50 bg-emerald-500/5'
                        : 'border-white/10 bg-neutral-900/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => void switchProject(p.id)}
                        disabled={busy}
                        className="min-w-0 flex-1 text-left disabled:opacity-60"
                      >
                        {active && renaming ? (
                          <input
                            autoFocus
                            value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onBlur={() => {
                              setRenaming(false);
                              void renameCurrentProject(nameDraft);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                          />
                        ) : (
                          <span className="block truncate text-sm font-medium">{p.name}</span>
                        )}
                        <span className="text-[11px] text-neutral-500">更新 {fmtDate(p.updated_at)}</span>
                      </button>

                      <div className="flex shrink-0 items-center gap-1.5 text-xs">
                        {active && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setNameDraft(projectName);
                                setRenaming(true);
                              }}
                              disabled={busy}
                              className="rounded px-2 py-1 text-neutral-300 transition hover:bg-white/10 disabled:opacity-50"
                            >
                              名前を変更
                            </button>
                            <button
                              type="button"
                              onClick={() => void duplicateCurrentProject()}
                              disabled={busy}
                              className="rounded px-2 py-1 text-neutral-300 transition hover:bg-white/10 disabled:opacity-50"
                            >
                              複製
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (window.confirm('このプロジェクトを削除しますか？（14日間は復元可能）')) {
                                  void deleteCurrentProject();
                                }
                              }}
                              disabled={busy || projects.length <= 1}
                              className="rounded px-2 py-1 text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
                            >
                              削除
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => void openProject(p.id)}
                          disabled={busy}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        >
                          開く →
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold">設定 / アップロード</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <ByokKeyPanel />
            <UploadPanel />
          </div>
        </section>
      </main>

      {creatingNew && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setCreatingNew(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-base font-bold">新しいプロジェクト</h3>
            <label className="mb-1 block text-xs text-neutral-400">プロジェクト名</label>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void confirmCreate();
                if (e.key === 'Escape') setCreatingNew(false);
              }}
              placeholder="マイプロジェクト"
              className="mb-4 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreatingNew(false)}
                className="rounded-lg bg-neutral-800 px-4 py-2 text-sm transition hover:bg-neutral-700"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirmCreate()}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                作成して開く
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
