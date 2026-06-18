import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * アプリ共通の確認ダイアログ（ネイティブ window.confirm の置き換え）。
 * ダーク UI に合わせた見た目で、削除などの破壊的操作の確認に使う。
 * 使い方: const confirm = useConfirm(); if (await confirm({ message, danger: true })) { ... }
 * ESC / 背景クリック / キャンセルで false、確定ボタン（Enter）で true を解決する。
 */
export interface ConfirmOptions {
  /** 本文（改行可）。 */
  message: string;
  /** 見出し（任意）。 */
  title?: string;
  /** 確定ボタンの文言（既定: OK）。 */
  confirmLabel?: string;
  /** キャンセルボタンの文言（既定: キャンセル）。 */
  cancelLabel?: string;
  /** 破壊的操作なら true で確定ボタンを赤系にする。 */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  // プロバイダ外（テスト等）ではネイティブ confirm にフォールバックして例外を投げない。
  const fallback = useCallback<ConfirmFn>((opts) => Promise.resolve(window.confirm(opts.message)), []);
  return ctx ?? fallback;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<ConfirmOptions | null>(null);
  // 解決関数は ref に保持（state 更新関数の中で副作用＝resolve を呼ばないため）。
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // 直前の確認が未解決なら false で解決して多重表示を避ける。
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setDialog(opts);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setDialog(null);
  }, []);

  // ESC でキャンセル（Enter は確定ボタンの autoFocus が処理する）。
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog && (
        <div
          className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => settle(false)}
          role="presentation"
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5 text-neutral-100 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {dialog.title && <h2 className="mb-2 text-sm font-black tracking-wide">{dialog.title}</h2>}
            <p className="whitespace-pre-line text-xs leading-relaxed text-neutral-300">{dialog.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => settle(false)}
                className="tap focus-ring rounded-lg border border-white/15 px-4 py-2 text-xs font-bold text-neutral-200 transition hover:bg-white/10"
              >
                {dialog.cancelLabel ?? 'キャンセル'}
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => settle(true)}
                className={`tap focus-ring rounded-lg px-4 py-2 text-xs font-black text-white transition ${
                  dialog.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {dialog.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
