import { createContext, useContext, type ReactNode } from 'react';
import { useProjectSession, type ProjectSession } from '../../hooks/useProjectSession.js';

// プロジェクトセッション（読み込み/autosave/複数プロジェクト操作）を 1 インスタンスだけ起動し、
// 保存インジケータとプロジェクトメニューの双方で共有するためのコンテキスト。
// ※ useProjectSession を複数箇所で直接呼ぶと autosave ループが二重化するため、必ずこの Provider 経由で。

const ProjectSessionContext = createContext<ProjectSession | null>(null);

export function ProjectSessionProvider({ children }: { children: ReactNode }) {
  const session = useProjectSession();
  return <ProjectSessionContext.Provider value={session}>{children}</ProjectSessionContext.Provider>;
}

export function useProjectSessionContext(): ProjectSession {
  const ctx = useContext(ProjectSessionContext);
  if (!ctx) {
    throw new Error('useProjectSessionContext は ProjectSessionProvider の内側で使用してください。');
  }
  return ctx;
}

/**
 * Provider の外側（ゲストモードでは App は Provider なしで描画される）でも安全に使える版。
 * セッションが無ければ null を返す。サムネイル保存など「ログイン時のみの副作用」に使う。
 */
export function useOptionalProjectSession(): ProjectSession | null {
  return useContext(ProjectSessionContext);
}
