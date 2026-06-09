import { useState, type ReactNode } from 'react';
import { HomeScreen } from '../HomeScreen.js';
import { AccountMenu } from './AccountMenu.js';
import { ProjectSaveIndicator } from '../ProjectSaveIndicator.js';
import { UndoRedoBar } from '../UndoRedoBar.js';

/**
 * ログイン後のシェル。ホーム画面（プロジェクト管理）とエディタ（2D/3D）を切り替える。
 * - 既定はホーム画面。プロジェクトを「開く」と entered=true でエディタを表示。
 * - エディタからは右上メニューの「ホーム」で戻れる。
 * ※ ProjectSessionProvider の内側で使用すること（ホーム・エディタで同一セッションを共有）。
 */
export function AuthedShell({ children }: { children: ReactNode }) {
  const [entered, setEntered] = useState(false);

  if (!entered) {
    return <HomeScreen onEnter={() => setEntered(true)} />;
  }

  return (
    <>
      {children}
      <AccountMenu onHome={() => setEntered(false)} />
      <ProjectSaveIndicator />
      <UndoRedoBar />
    </>
  );
}
