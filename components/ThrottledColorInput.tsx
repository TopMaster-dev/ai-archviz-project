import React, { useCallback, useEffect, useRef } from 'react';

/**
 * スロットル付きカラー入力（260709）。
 * ネイティブ `<input type="color">` のスポイト（eyedropper）は、画面上をなぞる間 onChange を毎フレーム連続発火する。
 * これを直接 setMaterialSettings 等につなぐと、3Dビューの再レンダーが毎フレーム走り、（重い処理があると）メイン
 * スレッドが固まる。→ 外部反映（重い状態更新）を throttleMs 間隔に間引く。
 *
 * さらに重要（260709 追修正）: 入力を「非制御（uncontrolled）」にする。
 * 制御コンポーネント（value={...}）にして React 側から毎回 value を書き換えると、ネイティブのカラーピッカー/スポイトが
 * 開いている最中に DOM 値を触ることになり、ピッカーが壊れて「スポイト使用後にクリック/ドラッグが拒否音とともに
 * 効かなくなる（操作不能）」不具合が起きる。対策として、操作中（＝入力にフォーカスがある間）は React から value を
 * 一切触らず、ブラウザにピッカーを任せる。外部で value が変わった場合のみ、フォーカスが外れているときに DOM 値を同期する。
 */
export function ThrottledColorInput({
  value,
  onChange,
  className,
  disabled,
  title,
  'aria-label': ariaLabel,
  throttleMs = 80,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  throttleMs?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const lastCommitRef = useRef(0);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 外部で value が変わったら DOM の値を同期する。ただし操作中（フォーカス中＝ピッカー/スポイトを開いている間）は
  // React から input を触らない（ネイティブピッカーを乱してフリーズ/操作不能にしないため）。
  useEffect(() => {
    const el = inputRef.current;
    if (el && document.activeElement !== el && el.value !== value) {
      el.value = value;
    }
  }, [value]);

  const flush = useCallback(() => {
    if (pendingRef.current != null) {
      onChangeRef.current(pendingRef.current);
      pendingRef.current = null;
      lastCommitRef.current = Date.now();
    }
  }, []);

  const handleChange = useCallback(
    (next: string) => {
      // setState はしない＝入力（DOM）を React で再レンダーしない。スロットルして onChange だけ間引く。
      pendingRef.current = next;
      const now = Date.now();
      const elapsed = now - lastCommitRef.current;
      if (elapsed >= throttleMs) {
        if (timerRef.current != null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        onChangeRef.current(next);
        pendingRef.current = null;
        lastCommitRef.current = now;
      } else if (timerRef.current == null) {
        // スロットル中＝末尾コミットを1つ予約（最後の値を確実に反映）
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          flush();
        }, throttleMs - elapsed);
      }
    },
    [throttleMs, flush]
  );

  // アンマウント時に保留中の値を取りこぼさずコミットしてタイマーを掃除する。
  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flush();
    };
  }, [flush]);

  return (
    <input
      type="color"
      ref={inputRef}
      defaultValue={value}
      onChange={(e) => e.target && handleChange(e.target.value)}
      className={className}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    />
  );
}
