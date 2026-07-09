import React, { useEffect, useRef } from 'react';

/**
 * 3Dマテリアル用のカラー入力（260709）。ネイティブ `<input type="color">` を安全に使うためのラッパー。
 *
 * 背景の不具合: 巾木/ドア等のカラーをネイティブのスポイト（eyedropper）で「画面（3D WebGLキャンバス）から」拾うと、
 * ブラウザが完全に固まり、ピッカーが開いたまま・警告音が鳴って操作不能になる。
 * 原因: スポイトはスクリーン（＝3Dキャンバス）のピクセルを読み取り続けるが、その最中に色反映で 3D を再レンダーすると、
 *   スポイトが読んでいるキャンバスと R3F の再描画が競合してハングする。制御コンポーネントでの value 書き換えや、
 *   input イベント（操作中に連続発火）での反映が引き金になる。
 *
 * 対策（本コンポーネント）:
 *  1) 非制御（uncontrolled）にする。操作中（フォーカス中＝ピッカー/スポイトを開いている間）は React から input を
 *     一切触らない。外部で value が変わったときのみ、フォーカスが外れているときに DOM 値を同期する。
 *  2) 色の反映は commit（＝ピッカーを閉じたときに発火する change イベント）だけで行い、input（操作中の連続発火）では
 *     一切反映しない。これにより「スポイトでスクリーンを読み取っている最中に 3D を再レンダーしない」＝競合・ハングを断つ。
 *     ライブプレビューは無くなるが、閉じた時点で最終色が確実に反映される（安全優先）。
 */
export function ThrottledColorInput({
  value,
  onChange,
  className,
  disabled,
  title,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 色の反映は「commit（ピッカーを閉じたとき＝change イベント）」のみ。input（操作中の連続発火）では反映しない。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onCommit = () => onChangeRef.current(el.value);
    el.addEventListener('change', onCommit);
    return () => el.removeEventListener('change', onCommit);
  }, []);

  // 外部で value が変わったら DOM の値を同期する。ただし操作中（フォーカス中＝ピッカーを開いている間）は触らない。
  useEffect(() => {
    const el = inputRef.current;
    if (el && document.activeElement !== el && el.value !== value) {
      el.value = value;
    }
  }, [value]);

  return (
    <input
      type="color"
      ref={inputRef}
      defaultValue={value}
      className={className}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    />
  );
}
