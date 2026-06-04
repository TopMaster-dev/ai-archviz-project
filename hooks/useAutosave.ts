import { useEffect, useRef } from 'react';

/**
 * 値の変化をデバウンスして保存する汎用 autosave フック。
 * 初回マウント時の値は保存しない（読み込み直後の無駄な書き込みを防ぐ）。
 *
 * @param value   監視対象（変化したら保存をスケジュール）
 * @param save    実保存処理
 * @param options delayMs（デバウンス、既定 1500ms）/ enabled（無効化可）
 */
export function useAutosave<T>(
  value: T,
  save: (value: T) => Promise<void> | void,
  options?: { delayMs?: number; enabled?: boolean },
): void {
  const delayMs = options?.delayMs ?? 1500;
  const enabled = options?.enabled ?? true;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirst = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!enabled) return;
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void saveRef.current(value);
    }, delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, enabled, delayMs]);
}
