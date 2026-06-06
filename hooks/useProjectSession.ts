import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useAuth } from '../lib/auth/AuthContext.js';
import { useProjectStore } from '../lib/store/projectStore.js';
import { useAutosave } from './useAutosave.js';
import { listProjects, getProject, createProject, saveProject } from '../lib/db/projects.js';
import { refreshGeminiKey, resetGeminiKeyCache } from '../lib/byok.js';

export type ProjectSessionStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'error';

export interface ProjectSession {
  status: ProjectSessionStatus;
  projectId: string | null;
}

/**
 * ログイン中ユーザーのプロジェクトを読み込み（無ければ作成）、以後ストアのドキュメント変更を
 * デバウンスして autosave する。
 *
 * ガード方針:
 *  - Supabase 未構成 / 未ログイン（ゲストモード）: 何もしない（従来どおりメモリ上のみで動作）。
 *  - 読み込み完了（ready）まで autosave しない（初期状態で上書きしないため）。
 *
 * 注意: 現時点でストア管理下にあるのは sketch / scene / materials。aiEdit / camera は
 *       別 state のため未永続化（該当スライス移行時に対応）。
 */
export function useProjectSession(): ProjectSession {
  const { configured, userId } = useAuth();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [status, setStatus] = useState<ProjectSessionStatus>('idle');

  // ログイン時に最新プロジェクトを読み込む（無ければ作成）。
  useEffect(() => {
    let active = true;
    if (!configured || !userId) {
      setProjectId(null);
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
        if (list.length > 0) {
          const proj = await getProject(list[0].id);
          if (proj) {
            useProjectStore.getState().loadProjectState(proj.data);
            id = proj.id;
          }
        }
        if (!id) {
          id = await createProject('マイプロジェクト', useProjectStore.getState().toProjectState());
        }
        if (!active) return;
        // 読み込み直後を Undo の起点にし、autosave の初回上書きも防ぐ。
        useProjectStore.temporal.getState().clear();
        setProjectId(id);
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

  // ドキュメント変更シグナル = temporal 履歴長（sketch/scene/materials の変更で増える）。
  const version = useStore(useProjectStore.temporal, (t) => t.pastStates.length);
  const enabled = configured && !!userId && !!projectId && status !== 'loading';

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

  return { status, projectId };
}
