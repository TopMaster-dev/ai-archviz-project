import { create } from 'zustand';

// 汎用ローディング・オーバーレイの状態（260630 クライアント要望）。
// 複製や 2D→3D 切替など「一瞬固まる」操作中に、円形スピナーのポップアップで「処理中」だと分かるようにする。
// 複数の発生源（reason）を同時に扱えるよう key 付き。1件でも残っていれば表示する（busy と view 切替の競合回避）。
interface LoadingState {
  reasons: Record<string, string>; // key → 表示メッセージ
  show: (key: string, message: string) => void;
  hide: (key: string) => void;
}

export const useLoadingStore = create<LoadingState>((set) => ({
  reasons: {},
  show: (key, message) =>
    set((s) => (s.reasons[key] === message ? s : { reasons: { ...s.reasons, [key]: message } })),
  hide: (key) =>
    set((s) => {
      if (!(key in s.reasons)) return s;
      const next = { ...s.reasons };
      delete next[key];
      return { reasons: next };
    }),
}));
