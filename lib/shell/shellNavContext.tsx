import { createContext, useContext, useMemo, type ReactNode } from 'react';

// ログイン後シェル（AuthedShell）のナビゲーション。
// 写真AI編集（2a）はフルスクリーンのオーバーレイで「ホームに戻る」ボタンを覆い隠すため、
// オーバーレイ内からホームへ戻れるよう goHome をコンテキストで配布する。
// ゲストモードでは Provider が無いため null を返す（呼び出し側でガードする）。

// homeBusy: 離脱時オートセーブ中（ホームへ戻る処理の実行中）。オーバーレイ側のホームボタンを
// 無効化＆「保存中…」表示にしてフィードバックを揃えるために配布する。
type ShellNav = { goHome: () => void; homeBusy: boolean };

const ShellNavContext = createContext<ShellNav | null>(null);

export function ShellNavProvider({
  goHome,
  homeBusy,
  children,
}: {
  goHome: () => void;
  homeBusy: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ goHome, homeBusy }), [goHome, homeBusy]);
  return <ShellNavContext.Provider value={value}>{children}</ShellNavContext.Provider>;
}

export function useShellNav(): ShellNav | null {
  return useContext(ShellNavContext);
}
