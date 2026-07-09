import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * スロットル付きカラー入力（260709）。
 * ネイティブ `<input type="color">` のスポイト（eyedropper）は、画面上をなぞる間 onChange を毎フレーム連続発火する。
 * これを直接 setMaterialSettings 等につなぐと、3Dビューの再レンダーが毎フレーム走り、（重い処理があると）メイン
 * スレッドが固まって画面が操作不能になる（クライアント報告：巾木/ドアのカラーをスポイトで変更すると固まる）。
 *
 * 対策: 入力の見た目（value）はローカルstateで即時更新して連続プレビューを保ちつつ、外部への反映（onChange＝
 * 重い状態更新）はスロットルして最大でも throttleMs 間隔に間引く。最後の値は末尾コミットで確実に反映する。
 * これでスポイトを使っても 3D 更新は間引かれ、固まらない。
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
  const [local, setLocal] = useState(value);
  const lastCommitRef = useRef(0);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 外部で value が変わったら（プロジェクト読込・別操作・コミット反映）ローカル表示へ同期する。
  useEffect(() => {
    setLocal(value);
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
      setLocal(next); // 入力の見た目は即時（スポイトのプレビューを保つ）
      pendingRef.current = next;
      const now = Date.now();
      const elapsed = now - lastCommitRef.current;
      if (elapsed >= throttleMs) {
        // 直近コミットから十分経過＝すぐ反映
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
      value={local}
      onChange={(e) => e.target && handleChange(e.target.value)}
      className={className}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    />
  );
}
