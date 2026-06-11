import { createContext, useContext, type ReactNode } from 'react';

// ログイン後シェル（AuthedShell）のナビゲーション。
// 写真AI編集（2a）はフルスクリーンのオーバーレイで「ホームに戻る」ボタンを覆い隠すため、
// オーバーレイ内からホームへ戻れるよう goHome をコンテキストで配布する。
// ゲストモードでは Provider が無いため null を返す（呼び出し側でガードする）。

type ShellNav = { goHome: () => void };

const ShellNavContext = createContext<ShellNav | null>(null);

export function ShellNavProvider({ goHome, children }: { goHome: () => void; children: ReactNode }) {
  return <ShellNavContext.Provider value={{ goHome }}>{children}</ShellNavContext.Provider>;
}

export function useShellNav(): ShellNav | null {
  return useContext(ShellNavContext);
}
