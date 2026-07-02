import { useCallback, useEffect, useState } from 'react';
import { Settings, Image as ImageIcon, HelpCircle } from 'lucide-react';
import { useAuth } from '../lib/auth/AuthContext.js';
import { useProjectSessionContext } from '../lib/project/projectSessionContext.js';
import { createShareLink, getDeletedProjects, purgeProject } from '../lib/db/projects.js';
import type { DeletedProjectSummary, ProjectSummary } from '../lib/db/types.js';
import { UploadPanel } from './UploadPanel.js';
import { SettingsModal } from './SettingsModal.js';
import { OnboardingGuide, ONBOARDING_SEEN_KEY } from './OnboardingGuide.js';
import { useConfirm } from './ConfirmDialog.js';
import {
  SURVEY_FORM_URL,
  recordAriseUse,
  shouldShowSurveyPrompt,
  markSurveyPrompted,
  dismissSurveyForever,
} from '../utils/surveyPrompt.js';

/**
 * ログインと2Dスケッチ（エディタ）の間に表示する独立した「ホーム画面」。
 * プロジェクトの一覧/選択/作成/複製/改名/削除、アップロード、ログアウトを集約する。
 * （Gemini APIキー設定は右上の設定モーダルへ集約。ホーム本体には表示しない。）
 * 「開く」でエディタへ遷移する（onEnter）。
 */
/** プロジェクトカードのサムネイル（2c-i）。親の aspect 比に追従して全面表示。未生成/失敗時はプレースホルダー。 */
function ProjectThumb({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const show = url && !failed;
  return (
    <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-600">
      {show ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <ImageIcon className="h-10 w-10" aria-label={`${name} のサムネイル（未生成）`} />
      )}
    </div>
  );
}

/** プロジェクトカードの自由メモ欄（260630・クライアント要望）。フォーカスを外すと変更分のみ保存する。 */
function ProjectMemoField({ memo, onSave }: { memo: string; onSave: (memo: string) => void }) {
  const [draft, setDraft] = useState(memo);
  useEffect(() => {
    setDraft(memo);
  }, [memo]);
  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== (memo ?? '').trim()) onSave(draft);
      }}
      placeholder="メモ（自由記入）"
      rows={2}
      aria-label="プロジェクトのメモ"
      className="w-full resize-none rounded-md border border-white/10 bg-neutral-950/60 px-2 py-1 text-[11px] leading-snug text-neutral-300 outline-none transition placeholder:text-neutral-600 focus:border-emerald-500/60"
    />
  );
}

export function HomeScreen({ onEnter }: { onEnter: () => void }) {
  const { email, signOut } = useAuth();
  const confirm = useConfirm();
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
    updateProjectMemo,
    duplicateCurrentProject,
    deleteCurrentProject,
    renameCurrentProject,
    restoreDeletedProject,
  } = useProjectSessionContext();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);
  // 新規作成: まず名前と種別を選んでから遷移（2c-iii / 2a）。
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('マイプロジェクト');
  const [newMemo, setNewMemo] = useState('');
  const [newKind, setNewKind] = useState<'full' | 'photo'>('full');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 操作ガイド（オンボーディング）。初回のみ自動表示し、以降は右上の「?」から見返せる（260623）。
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // 共有（2b）: 閲覧用URLの発行・クリップボードコピーの結果通知。
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  // プロジェクト名での絞り込み検索（管理表 row 69）。
  const [query, setQuery] = useState('');
  // 削除済み（猶予期間内）プロジェクトの復元メニュー（管理表 row 109/110）。
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedProjects, setDeletedProjects] = useState<DeletedProjectSummary[]>([]);
  // 完全削除/AI画像削除後に UploadPanel の使用量バーを再取得させるためのシグナル（260629）。
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const [deletedQuery, setDeletedQuery] = useState('');
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [deletedError, setDeletedError] = useState<string | null>(null);
  useEffect(() => {
    if (!renaming) setNameDraft(projectName);
  }, [projectName, renaming]);

  // 初回訪問時だけガイドを自動で開く（以降は右上の「?」ボタンから見返せる・260623）。
  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARDING_SEEN_KEY)) {
        setOnboardingOpen(true);
        localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
      }
    } catch {
      setOnboardingOpen(true);
    }
  }, []);

  const loadDeleted = useCallback(async () => {
    setDeletedLoading(true);
    setDeletedError(null);
    try {
      setDeletedProjects(await getDeletedProjects());
    } catch {
      setDeletedError('削除済みプロジェクトの取得に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setDeletedLoading(false);
    }
  }, []);
  const toggleDeleted = () => {
    setShowDeleted((prev) => {
      const next = !prev;
      if (next) void loadDeleted();
      return next;
    });
  };
  const handleRestore = async (id: string) => {
    await restoreDeletedProject(id);
    // 復元したものは削除済み一覧から消え、アクティブ一覧へ戻る。
    await loadDeleted();
    setUsageRefreshKey((k) => k + 1); // 復元でAI画像が「削除済」→「AI生成画像」へ戻るのを使用量バーに反映
  };
  // 論理削除（アクティブカードの「削除」）後に、削除済一覧と使用量バー（削除済カテゴリ）を更新する。
  const handleSoftDelete = async () => {
    await deleteCurrentProject();
    setUsageRefreshKey((k) => k + 1); // AI画像が「AI生成画像」→「削除済(一時保管中)」へ移るのを反映
    void loadDeleted();
  };
  // 完全削除（260629）: 猶予を待たず即時に物理削除＋AI生成画像の容量解放。確認必須。
  const handlePurge = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'プロジェクトを完全に削除',
      message: `「${name}」を完全に削除しますか？\nAI生成画像も削除され、空き容量に反映されます。元に戻せません。`,
      confirmLabel: '完全に削除',
      danger: true,
    });
    if (!ok) return;
    setPurgingId(id);
    setDeletedError(null);
    try {
      await purgeProject(id);
      setDeletedProjects((prev) => prev.filter((p) => p.id !== id));
      setUsageRefreshKey((k) => k + 1); // 使用量バーを再取得（容量解放を反映）
    } catch {
      setDeletedError('完全削除に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setPurgingId(null);
    }
  };
  const daysUntilPurge = (iso: string | null) => {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86_400_000));
  };

  const handleShare = async (id: string) => {
    setSharingId(id);
    setShareNotice(null);
    try {
      const token = await createShareLink(id);
      const url = `${window.location.origin}${window.location.pathname}?share=${token}`;
      try {
        await navigator.clipboard.writeText(url);
        setShareNotice('閲覧用URLをコピーしました。リンクを知っている人は誰でも閲覧できます。');
      } catch {
        // クリップボード不可（権限・非セキュアコンテキスト等）: 手動コピー用にURLを表示。
        setShareNotice(url);
      }
    } catch {
      setShareNotice('共有リンクの発行に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setSharingId(null);
    }
  };

  const usage = plan === 'free' ? `${projectCount} / ${projectLimit}` : `${projectCount}`;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProjects = normalizedQuery
    ? projects.filter((p) => p.name.toLowerCase().includes(normalizedQuery))
    : projects;

  // アンケート促しポップアップ（260626）: 一定回数の利用ごとに表示。判定はホーム表示時に1回。
  const [showSurvey, setShowSurvey] = useState(false);
  useEffect(() => {
    if (shouldShowSurveyPrompt()) setShowSurvey(true);
  }, []);

  const openProject = async (id: string) => {
    if (id !== projectId) await switchProject(id);
    recordAriseUse(); // 「Arise を1回使った」＝プロジェクトを開いた、として記録（アンケート促し用）
    onEnter();
  };
  const confirmCreate = async () => {
    const name = newName.trim() || 'マイプロジェクト';
    setCreatingNew(false);
    await createNewProject(name, newKind, newMemo);
    setNewMemo('');
    recordAriseUse();
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

  // プロジェクトカード（260623: カテゴリ別に2回マップするため関数化）。
  const renderCard = (p: ProjectSummary) => {
    const active = p.id === projectId;
    // パネル内の操作要素（名称変更入力・メモ・操作ボタン）はカード全体のクリック/ダブルクリックを
    // 発火させない（例: 削除ボタンやメモ入力でプロジェクトが開いてしまうのを防ぐ）。260702。
    const stopEvent = (e: { stopPropagation: () => void }) => e.stopPropagation();
    return (
      <li
        key={p.id}
        onClick={() => {
          if (!busy) void switchProject(p.id);
        }}
        onDoubleClick={() => {
          if (!busy) void openProject(p.id);
        }}
        title="クリックで選択 / ダブルクリックで開く"
        className={`flex cursor-pointer flex-col overflow-hidden rounded-xl border transition ${
          active
            ? 'border-emerald-500/60 bg-emerald-500/5'
            : 'border-white/10 bg-neutral-900/40 hover:border-white/25'
        }`}
      >
        {/* サムネイル（パネル全体クリックで選択・ダブルクリックで開く・260702） */}
        <div className="block aspect-video w-full overflow-hidden bg-neutral-800">
          <ProjectThumb url={p.thumbnail_url} name={p.name} />
        </div>

        {/* 情報 + 操作 */}
        <div className="flex flex-1 flex-col gap-2 p-3">
          {active && renaming ? (
            <input
              autoFocus
              value={nameDraft}
              onClick={stopEvent}
              onDoubleClick={stopEvent}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                setRenaming(false);
                void renameCurrentProject(nameDraft);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm outline-none focus:border-emerald-500"
            />
          ) : (
            <span className="block truncate text-sm font-semibold" title={p.name}>
              {p.name}
            </span>
          )}
          <span className="text-[11px] text-neutral-500">更新 {fmtDate(p.updated_at)}</span>
          {/* メモ入力はカードのクリック/ダブルクリックを発火させない（入力・単語選択の妨げ防止）。 */}
          <div onClick={stopEvent} onDoubleClick={stopEvent}>
            <ProjectMemoField memo={p.memo ?? ''} onSave={(m) => void updateProjectMemo(p.id, m)} />
          </div>

          <div
            onClick={stopEvent}
            onDoubleClick={stopEvent}
            className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-xs"
          >
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
                  onClick={() => void handleShare(p.id)}
                  disabled={busy || sharingId === p.id}
                  title="閲覧用URLを発行してコピー"
                  className="rounded px-2 py-1 text-neutral-300 transition hover:bg-white/10 disabled:opacity-50"
                >
                  {sharingId === p.id ? '発行中…' : '共有'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await confirm({
                        message: 'このプロジェクトを削除しますか？（14日間は復元可能）',
                        confirmLabel: '削除',
                        danger: true,
                      })
                    ) {
                      void handleSoftDelete();
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
              className="ml-auto rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              開く →
            </button>
          </div>
        </div>
      </li>
    );
  };
  // カテゴリ分け（260623）: 種別 'photo'=写真をAI編集 / それ以外=空間デザイン。
  const spaceProjects = filteredProjects.filter((p) => p.kind !== 'photo');
  const photoProjects = filteredProjects.filter((p) => p.kind === 'photo');

  return (
    <div className="relative h-screen w-screen overflow-y-auto bg-neutral-950 text-neutral-100">
      {/* 背景の装飾グラデーション（LP と同じモヤッとした演出・260626 クライアント要望: 余白を埋める）。pointer-events-none で操作を妨げない。 */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div
          className="absolute -top-32 -left-24 h-[28rem] w-[28rem] rounded-full bg-emerald-500/20 blur-3xl animate-pulse"
          style={{ animationDuration: '7s' }}
        />
        <div
          className="absolute top-1/3 -right-24 h-[26rem] w-[26rem] rounded-full bg-sky-500/15 blur-3xl animate-pulse"
          style={{ animationDuration: '9s', animationDelay: '1s' }}
        />
        <div
          className="absolute bottom-0 left-1/3 h-[24rem] w-[24rem] rounded-full bg-purple-500/10 blur-3xl animate-pulse"
          style={{ animationDuration: '11s', animationDelay: '2s' }}
        />
      </div>
      <header className="relative flex items-center justify-between border-b border-white/10 px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">Arise</h1>
          <p className="text-[11px] text-neutral-400">建築・内装向け AI 空間デザイン</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => setOnboardingOpen(true)}
            title="使い方ガイド"
            aria-label="使い方ガイド"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-800 text-neutral-300 transition hover:bg-neutral-700 hover:text-white"
          >
            <HelpCircle className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="設定（プロフィール・APIキー）"
            aria-label="設定"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-800 text-neutral-300 transition hover:bg-neutral-700 hover:text-white"
          >
            <Settings className="h-4 w-4" />
          </button>
          <span className="hidden text-neutral-400 sm:inline" title={email ?? ''}>
            {email}
          </span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-md bg-neutral-800 px-3 py-1.5 transition hover:bg-neutral-700"
          >
            ログアウト
          </button>
        </div>
      </header>

      <main className="relative mx-auto max-w-5xl px-6 py-8">
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              プロジェクト
              <span className="ml-2 text-xs font-normal text-neutral-500" title="保存件数">
                {usage}
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setNewName('マイプロジェクト'); setNewKind('full'); setCreatingNew(true); }}
                disabled={busy || atLimit}
                title={atLimit ? 'フリープランの保存上限に達しています' : '新しいプロジェクトを作成して開く'}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                ＋ 新規作成
              </button>
              {/* ご意見・ご要望（Google フォーム）への導線（260626 クライアント要望）。別タブで開く。 */}
              <a
                href={SURVEY_FORM_URL}
                target="_blank"
                rel="noopener noreferrer"
                title="ご意見・ご要望フォーム（Google フォーム）を開く"
                className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-white/30 hover:text-white"
              >
                ご意見・ご要望はこちら
              </a>
            </div>
          </div>

          {atLimit && (
            <p className="mb-2 text-xs text-amber-300">
              フリープランの保存上限（{projectLimit}件）に達しました。不要なプロジェクトを削除してください。
            </p>
          )}
          {error && <p className="mb-2 text-xs text-red-300">{error}</p>}

          {projects.length > 0 && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="プロジェクトを検索…"
              aria-label="プロジェクトを検索"
              className="mb-3 w-full max-w-xs rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
          )}

          {(status === 'loading' || status === 'idle') && projects.length === 0 ? (
            // 認証復元中(idle)や読込中(loading)は「無い」ではなく「読み込み中」を出す（初回ログイン/リロードの取りこぼし防止・260630）。
            <p className="text-sm text-neutral-500">読み込み中…</p>
          ) : status === 'error' && projects.length === 0 ? (
            <p className="text-sm text-red-300">
              プロジェクトの読み込みに失敗しました。ページを再読み込みしてお試しください。
            </p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-neutral-500">
              プロジェクトがありません。「＋ 新規作成」から始めてください。
            </p>
          ) : filteredProjects.length === 0 ? (
            <p className="text-sm text-neutral-500">「{query.trim()}」に一致するプロジェクトはありません。</p>
          ) : (
            <div className="space-y-8">
              {spaceProjects.length > 0 && (
                <div>
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-neutral-300">
                    空間デザイン
                    <span className="text-xs font-normal text-neutral-500">{spaceProjects.length}</span>
                  </h3>
                  <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {spaceProjects.map(renderCard)}
                  </ul>
                </div>
              )}
              {photoProjects.length > 0 && (
                <div>
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-neutral-300">
                    写真をAI編集
                    <span className="text-xs font-normal text-neutral-500">{photoProjects.length}</span>
                  </h3>
                  <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {photoProjects.map(renderCard)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 削除済みプロジェクトの復元（猶予期間内・管理表 row 109/110） */}
        <section className="mb-8">
          <button
            type="button"
            onClick={toggleDeleted}
            className="text-sm font-semibold text-neutral-400 transition hover:text-neutral-200"
          >
            {showDeleted ? '▾ 削除済み（復元できます）' : '▸ 削除済み（復元できます）'}
          </button>

          {showDeleted && (
            <div className="mt-3">
              {deletedProjects.length > 0 && (
                <input
                  type="search"
                  value={deletedQuery}
                  onChange={(e) => setDeletedQuery(e.target.value)}
                  placeholder="削除済みを名称で検索…"
                  aria-label="削除済みプロジェクトを検索"
                  className="mb-3 w-full max-w-xs rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-emerald-500"
                />
              )}

              {deletedLoading ? (
                <p className="text-sm text-neutral-500">読み込み中…</p>
              ) : deletedError ? (
                <p className="text-sm text-red-300">{deletedError}</p>
              ) : deletedProjects.length === 0 ? (
                <p className="text-sm text-neutral-500">猶予期間内に削除したプロジェクトはありません。</p>
              ) : (
                (() => {
                  const dq = deletedQuery.trim().toLowerCase();
                  const filtered = dq
                    ? deletedProjects.filter((p) => p.name.toLowerCase().includes(dq))
                    : deletedProjects;
                  if (filtered.length === 0) {
                    return (
                      <p className="text-sm text-neutral-500">
                        「{deletedQuery.trim()}」に一致する削除済みプロジェクトはありません。
                      </p>
                    );
                  }
                  return (
                    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {filtered.map((p) => {
                        const left = daysUntilPurge(p.scheduled_purge_at);
                        return (
                          <li
                            key={p.id}
                            className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-900/40 opacity-90"
                          >
                            <div className="aspect-video w-full overflow-hidden bg-neutral-800 grayscale">
                              <ProjectThumb url={p.thumbnail_url} name={p.name} />
                            </div>
                            <div className="flex flex-1 flex-col gap-2 p-3">
                              <span className="block truncate text-sm font-semibold" title={p.name}>
                                {p.name}
                              </span>
                              <span className="text-[11px] font-semibold text-red-400">
                                {left === null ? '猶予期間内' : `あと ${left} 日で完全削除`}
                              </span>
                              <div className="mt-auto flex items-center justify-end gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={() => void handlePurge(p.id, p.name)}
                                  disabled={busy || purgingId === p.id}
                                  title="猶予を待たず今すぐ削除し、空き容量に反映します"
                                  className="rounded px-2 py-1 text-xs text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
                                >
                                  {purgingId === p.id ? '削除中…' : '今すぐ完全削除'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleRestore(p.id)}
                                  disabled={busy || purgingId === p.id}
                                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                                >
                                  復元
                                </button>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()
              )}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold">アップロード</h2>
          <div className="grid grid-cols-1 gap-3">
            <UploadPanel refreshSignal={usageRefreshKey} />
          </div>
        </section>
      </main>

      {creatingNew && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setCreatingNew(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900 p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-5 text-xl font-bold">新しいプロジェクト</h3>
            <label className="mb-1.5 block text-sm text-neutral-400">プロジェクト名</label>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void confirmCreate();
                if (e.key === 'Escape') setCreatingNew(false);
              }}
              placeholder="マイプロジェクト"
              className="mb-4 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-neutral-100 outline-none focus:border-emerald-500"
            />

            {/* メモ欄（260630・クライアント要望）。作成時に任意で記入でき、後から各カードでも編集可。 */}
            <label className="mb-1.5 block text-sm text-neutral-400">メモ（任意）</label>
            <textarea
              value={newMemo}
              onChange={(e) => setNewMemo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setCreatingNew(false);
              }}
              placeholder="このプロジェクトのメモ（自由記入）"
              rows={2}
              className="mb-6 w-full resize-none rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-2.5 text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />

            <label className="mb-1.5 block text-sm text-neutral-400">種類</label>
            <div className="mb-7 grid grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setNewKind('full')}
                className={`overflow-hidden rounded-lg border text-left transition ${
                  newKind === 'full'
                    ? 'border-emerald-500/60 bg-emerald-500/10'
                    : 'border-neutral-700 bg-neutral-950 hover:border-neutral-600'
                }`}
              >
                <img src="/lp/lp-step-2d-3d-ai.jpg" alt="" loading="lazy" className="aspect-video w-full object-cover" />
                <span className="block p-4">
                  <span className="block text-base font-semibold">図面からパース作成</span>
                  <span className="mt-1 block text-xs text-neutral-400">2D作図 → 3D → AIレンダリング</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setNewKind('photo')}
                className={`overflow-hidden rounded-lg border text-left transition ${
                  newKind === 'photo'
                    ? 'border-emerald-500/60 bg-emerald-500/10'
                    : 'border-neutral-700 bg-neutral-950 hover:border-neutral-600'
                }`}
              >
                <img src="/lp/lp-ai-edit.jpg" alt="" loading="lazy" className="aspect-video w-full object-cover" />
                <span className="block p-4">
                  <span className="block text-base font-semibold">AI で写真編集</span>
                  <span className="mt-1 block text-xs text-neutral-400">写真をアップロードしてAI画像編集</span>
                </span>
              </button>
            </div>

            <div className="mt-2 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setCreatingNew(false)}
                className="rounded-lg bg-neutral-800 px-5 py-2.5 text-base transition hover:bg-neutral-700"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirmCreate()}
                className="rounded-lg bg-emerald-600 px-5 py-2.5 text-base font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                作成して開く
              </button>
            </div>
          </div>
        </div>
      )}

      {shareNotice && (
        <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
          <div className="flex max-w-xl items-start gap-3 rounded-xl border border-white/10 bg-neutral-800 px-4 py-3 shadow-2xl">
            <p className="min-w-0 flex-1 break-all text-xs text-neutral-200" style={{ userSelect: 'text' }}>
              {shareNotice.startsWith('http') ? (
                <>
                  <span className="mb-1 block text-neutral-400">下のURLをコピーしてください：</span>
                  {shareNotice}
                </>
              ) : (
                shareNotice
              )}
            </p>
            <button
              type="button"
              onClick={() => setShareNotice(null)}
              className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 transition hover:bg-white/10"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      <OnboardingGuide open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />

      {/* アンケート促しポップアップ（260626 クライアント要望）。一定回数の利用ごとに表示。 */}
      {showSurvey && (
        <div
          className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="survey-title"
          onClick={() => { markSurveyPrompted(); setShowSurvey(false); }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="survey-title" className="text-base font-black text-white">
              アンケートご協力のお願い
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-300">
              Arise をご利用いただきありがとうございます。よりよいサービスづくりのため、使用感アンケート（Google
              フォーム）へのご記入にご協力いただけますと幸いです。
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => { dismissSurveyForever(); setShowSurvey(false); }}
                className="rounded-lg px-3 py-2 text-xs font-semibold text-neutral-400 transition hover:text-neutral-200"
              >
                今後表示しない
              </button>
              <button
                type="button"
                onClick={() => { markSurveyPrompted(); setShowSurvey(false); }}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm font-bold text-neutral-200 transition hover:bg-white/10"
              >
                後で
              </button>
              <a
                href={SURVEY_FORM_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => { markSurveyPrompted(); setShowSurvey(false); }}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-500"
              >
                フォームを開く
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
