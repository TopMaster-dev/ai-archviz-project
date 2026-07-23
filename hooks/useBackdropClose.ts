import { useRef } from 'react';
import type React from 'react';

/**
 * モーダルの「背景（オーバーレイ）クリックで閉じる」を安全にするフック（260724・クライアント不具合対応）。
 *
 * 問題: 背景に `onClick={close}` を付けると、入力欄の中でドラッグして文字を選択し、そのまま背景の上でマウスを
 * 離した場合（あるいは 3Dプレビューをドラッグ回転して背景外で離した場合）に、click イベントが
 * 「mousedown と mouseup の最も近い共通祖先＝背景」へ発火するため、意図せずポップアップが閉じてしまう。
 * 内側ダイアログの stopPropagation では防げない（click は内側から伝播するのではなく背景に直接発火するため）。
 *
 * 解決: 押下（mousedown）が背景の上で始まり、かつ click 対象も背景のときだけ閉じる。入力欄やプレビューで
 * 始まったドラッグは downOnBackdrop=false となり、背景で離しても閉じない。純粋な背景クリックのみ閉じる。
 *
 * 使い方: `<div className="fixed inset-0 ..." {...useBackdropClose(onClose)}>` を背景要素に付ける。
 */
export function useBackdropClose(onClose: () => void): {
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
} {
  const downOnBackdrop = useRef(false);
  return {
    onMouseDown: (e) => {
      downOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e) => {
      if (e.target === e.currentTarget && downOnBackdrop.current) onClose();
      downOnBackdrop.current = false;
    },
  };
}
