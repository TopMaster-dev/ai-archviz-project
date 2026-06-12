import { useCallback, useEffect, useRef } from 'react';

/**
 * 値の変化をデバウンスして保存する汎用 autosave フック。
 * 初回マウント時の値は保存しない（読み込み直後の無駄な書き込みを防ぐ）。
 *
 * 戻り値の cancel() で保留中のデバウンス保存を取り消せる（即時保存＝flush 後に
 * 重複した遅延書き込みが走るのを防ぐ用途。離脱時オートセーブで使用）。
 *
 * @param value   監視対象（変化したら保存をスケジュール）
 * @param save    実保存処理
 * @param options delayMs（デバウンス、既定 1500ms）/ enabled（無効化可）
 * @returns cancel  保留中のデバウンス保存を取り消す
 */
export function useAutosave<T>(
  value: T,
  save: (value: T) => Promise<void> | void,
  options?: { delayMs?: number; enabled?: boolean },
): { cancel: () => void } {
  const delayMs = options?.delayMs ?? 1500;
  const enabled = options?.enabled ?? true;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirst = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

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

  return { cancel };
}
