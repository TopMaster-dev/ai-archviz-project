import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useAuth } from '../lib/auth/AuthContext.js';
import { useProjectStore } from '../lib/store/projectStore.js';
import { useAutosave } from './useAutosave.js';
import {
  listProjects,
  getProject,
  createProject,
  saveProject,
  duplicateProject,
  softDeleteProject,
  isFreePlanLimitError,
  FREE_PLAN_PROJECT_LIMIT,
} from '../lib/db/projects.js';
import { createEmptyProjectState, type ProjectState, type ProjectKind } from '../lib/project/projectState.js';
import { refreshGeminiKey, resetGeminiKeyCache } from '../lib/byok.js';
import type { ProjectSummary, PlanType } from '../lib/db/types.js';

const DEFAULT_PROJECT_NAME = 'マイプロジェクト';

export type ProjectSessionStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'error';

export interface ProjectSession {
  status: ProjectSessionStatus;
  projectId: string | null;
  projectName: string;
  /** 自分の未削除プロジェクト一覧（更新日降順）。 */
  projects: ProjectSummary[];
  plan: PlanType;
  projectCount: number;
  /** フリーは上限件数、有料は null（無制限）。 */
  projectLimit: number | null;
  /** フリープランで上限に達しているか（新規作成を抑止）。 */
  atLimit: boolean;
  /** プロジェクト操作の実行中（UI のボタン無効化用）。 */
  busy: boolean;
  /** 直近の操作エラー（上限超過の案内などを含む）。 */
  error: string | null;
  switchProject(id: string): Promise<void>;
  createNewProject(name?: string, kind?: ProjectKind): Promise<void>;
  duplicateCurrentProject(): Promise<void>;
  renameCurrentProject(name: string): Promise<void>;
  deleteCurrentProject(): Promise<void>;
  /** 現在のプロジェクトの一覧用サムネイル（data URL）を保存する。背景副作用（busy/status に影響しない）。 */
  setProjectThumbnail(dataUrl: string): Promise<void>;
  /** 写真AI編集（2a）の現在ストア内容をデバウンス保存する。aiEdit は temporal 対象外で autosave されないため別途呼ぶ。 */
  persistAiEdit(): void;
}

function messageOf(e: unknown): string {
  if (isFreePlanLimitError(e)) {
    return `フリープランの保存上限（${FREE_PLAN_PROJECT_LIMIT}件）に達しています。不要なプロジェクトを削除してください。`;
  }
  if (e instanceof Error) return e.message;
  // Supabase/PostgREST のエラーは Error インスタンスでない素のオブジェクト。実際の message を表面化する。
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; details?: unknown; hint?: unknown };
    const parts = [o.message, o.details, o.hint].filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (parts.length > 0) return parts.join(' / ');
  }
  return 'エラーが発生しました。';
}

/**
 * ログイン中ユーザーのプロジェクトを読み込み（無ければ作成）、以後ストアのドキュメント変更を
 * デバウンスして autosave する。加えて複数プロジェクトの作成/一覧/切替/複製/改名/削除と、
 * フリープランの保存上限（UX）を扱う。
 *
 * ガード方針:
 *  - Supabase 未構成 / 未ログイン（ゲストモード）: 何もしない（従来どおりメモリ上のみで動作）。
 *  - 読み込み中・操作中（busy）は autosave しない（切替直後の誤上書きを防ぐ）。
 *
 * 単一インスタンス前提: ストアは singleton のため、この hook は ProjectSessionProvider 経由で
 * 1 度だけ呼ぶこと（複数呼び出しは autosave ループの二重化になる）。
 *
 * 注意: 現時点でストア管理下にあるのは sketch / scene / materials。aiEdit / camera は
 *       別 state のため未永続化（該当スライス移行時に対応）。
 */
export function useProjectSession(): ProjectSession {
  const { configured, userId, profile } = useAuth();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [status, setStatus] = useState<ProjectSessionStatus>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan: PlanType = profile?.plan ?? 'free';
  const projectLimit = plan === 'free' ? FREE_PLAN_PROJECT_LIMIT : null;
  const projectCount = projects.length;
  const atLimit = projectLimit !== null && projectCount >= projectLimit;

  // ログイン時に最新プロジェクトを読み込む（無ければ作成）。
  useEffect(() => {
    let active = true;
    if (!configured || !userId) {
      setProjectId(null);
      setProjectName('');
      setProjects([]);
      setStatus('idle');
      resetGeminiKeyCache();
      return;
    }
    (async () => {
      setStatus('loading');
      // BYOK: 保存済みの Gemini キーをメモリへ読み込む（生成 fetch で使用）。プロジェクト読込とは独立。
      void refreshGeminiKey();
      try {
        const list = await listProjects();
        let id: string | null = null;
        let name = '';
        if (list.length > 0) {
          const proj = await getProject(list[0].id);
          if (proj) {
            useProjectStore.getState().loadProjectState(proj.data);
            id = proj.id;
            name = proj.name;
          }
        }
        if (!id) {
          id = await createProject(DEFAULT_PROJECT_NAME, useProjectStore.getState().toProjectState());
          name = DEFAULT_PROJECT_NAME;
        }
        if (!active) return;
        // 読み込み直後を Undo の起点にし、autosave の初回上書きも防ぐ。
        useProjectStore.temporal.getState().clear();
        setProjects(await listProjects());
        setProjectId(id);
        setProjectName(name);
        setStatus('ready');
      } catch (e) {
        console.error('[project session] load/create failed', e);
        if (active) setStatus('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [configured, userId]);

  // 現在のストア内容を指定プロジェクトへ即時保存（切替・複製・削除前のフラッシュ）。
  const flush = useCallback(async (id: string | null) => {
    if (!id) return;
    await saveProject(id, { data: useProjectStore.getState().toProjectState() });
  }, []);

  // ProjectState をエディタへ反映し、Undo 履歴を起点化する。
  const loadInto = useCallback((data: ProjectState) => {
    useProjectStore.getState().loadProjectState(data);
    useProjectStore.temporal.getState().clear();
  }, []);

  const refreshList = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  const switchProject = useCallback(
    async (id: string) => {
      if (id === projectId || busy) return;
      setBusy(true);
      setError(null);
      setStatus('loading');
      try {
        await flush(projectId);
        const proj = await getProject(id);
        if (!proj) throw new Error('プロジェクトが見つかりません。');
        loadInto(proj.data);
        setProjectId(proj.id);
        setProjectName(proj.name);
        setStatus('ready');
      } catch (e) {
        console.error('[project session] switch failed', e);
        setError(messageOf(e));
        setStatus('ready');
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, flush, loadInto],
  );

  const createNewProject = useCallback(
    async (name: string = DEFAULT_PROJECT_NAME, kind: ProjectKind = 'full') => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setStatus('loading');
      try {
        await flush(projectId);
        const blank = createEmptyProjectState();
        blank.kind = kind; // 2a: 写真AI編集専用('photo') か 空間デザイン('full')。
        // 先に行を作成（ここで上限トリガが発火しうる）。失敗時はエディタ状態を変えない。
        const id = await createProject(name, blank);
        loadInto(blank);
        setProjectId(id);
        setProjectName(name);
        await refreshList();
        setStatus('ready');
      } catch (e) {
        console.error('[project session] create failed', e);
        setError(messageOf(e));
        setStatus('ready');
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, flush, loadInto, refreshList],
  );

  const duplicateCurrentProject = useCallback(async () => {
    if (!projectId || busy) return;
    setBusy(true);
    setError(null);
    setStatus('loading');
    try {
      await flush(projectId);
      const id = await duplicateProject(projectId); // 上限トリガが発火しうる
      await refreshList();
      const proj = await getProject(id);
      if (proj) {
        loadInto(proj.data);
        setProjectId(proj.id);
        setProjectName(proj.name);
      }
      setStatus('ready');
    } catch (e) {
      console.error('[project session] duplicate failed', e);
      setError(messageOf(e));
      setStatus('ready');
    } finally {
      setBusy(false);
    }
  }, [projectId, busy, flush, loadInto, refreshList]);

  const renameCurrentProject = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!projectId || busy || !trimmed || trimmed === projectName) return;
      setBusy(true);
      setError(null);
      try {
        await saveProject(projectId, { name: trimmed });
        setProjectName(trimmed);
        await refreshList();
      } catch (e) {
        console.error('[project session] rename failed', e);
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [projectId, projectName, busy, refreshList],
  );

  const deleteCurrentProject = useCallback(async () => {
    if (!projectId || busy) return;
    setBusy(true);
    setError(null);
    setStatus('loading');
    try {
      await softDeleteProject(projectId);
      const list = await listProjects();
      setProjects(list);
      if (list.length > 0) {
        const proj = await getProject(list[0].id);
        if (proj) {
          loadInto(proj.data);
          setProjectId(proj.id);
          setProjectName(proj.name);
        }
      } else {
        // 最後の 1 件を消した場合は空プロジェクトを作り直す。
        const blank = createEmptyProjectState();
        const id = await createProject(DEFAULT_PROJECT_NAME, blank);
        loadInto(blank);
        setProjectId(id);
        setProjectName(DEFAULT_PROJECT_NAME);
        setProjects(await listProjects());
      }
      setStatus('ready');
    } catch (e) {
      console.error('[project session] delete failed', e);
      setError(messageOf(e));
      setStatus('ready');
    } finally {
      setBusy(false);
    }
  }, [projectId, busy, loadInto]);

  // 現在プロジェクトの一覧用サムネイルを保存（2c-i）。AI レンダー結果から生成して呼ばれる。
  // 背景副作用として扱い、busy/status や autosave には干渉しない。失敗は握りつぶす。
  const setProjectThumbnail = useCallback(
    async (dataUrl: string) => {
      if (!configured || !userId || !projectId || !dataUrl) return;
      try {
        await saveProject(projectId, { thumbnail_url: dataUrl });
        // 再フェッチ不要で一覧の該当行へ即時反映。
        setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, thumbnail_url: dataUrl } : p)));
      } catch (e) {
        console.error('[project session] thumbnail save failed', e);
      }
    },
    [configured, userId, projectId],
  );

  // 写真AI編集（2a）の保存。aiEdit は temporal（Undo）対象外のため通常 autosave されない。
  // 変更が来るたびにデバウンスして data 全体（kind/aiEdit を含む）を保存する。失敗は握りつぶす。
  const aiEditSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistAiEdit = useCallback(() => {
    if (!configured || !userId || !projectId) return;
    const id = projectId;
    if (aiEditSaveTimer.current) clearTimeout(aiEditSaveTimer.current);
    aiEditSaveTimer.current = setTimeout(() => {
      void saveProject(id, { data: useProjectStore.getState().toProjectState() }).catch((e) =>
        console.error('[project session] aiEdit save failed', e),
      );
    }, 800);
  }, [configured, userId, projectId]);

  // ドキュメント変更シグナル = temporal 履歴長（sketch/scene/materials の変更で増える）。
  const version = useStore(useProjectStore.temporal, (t) => t.pastStates.length);
  const enabled = configured && !!userId && !!projectId && status !== 'loading' && !busy;

  useAutosave(
    version,
    async () => {
      if (!enabled || !projectId) return;
      setStatus('saving');
      try {
        await saveProject(projectId, { data: useProjectStore.getState().toProjectState() });
        setStatus('ready');
      } catch (e) {
        console.error('[project session] autosave failed', e);
        setStatus('error');
      }
    },
    { delayMs: 2000, enabled },
  );

  return {
    status,
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
    setProjectThumbnail,
    persistAiEdit,
  };
}
