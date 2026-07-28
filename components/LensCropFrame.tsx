import { useCallback, useEffect, useRef } from 'react';
import { clampRect, type NormRect } from '../utils/cropRegion.js';

/**
 * Google レンズ風のクロップ枠（260729 クライアント要望）。
 *
 * 生成画像プレビューの上に直接置き、枠の中だけを明るく残して外側を暗転させる。
 * 枠は既定で画像全体を覆い、利用者が辺・角をドラッグして対象へ絞り込む。
 *
 * 【設計上の約束】
 *  - 位置とサイズは常に「画像全体を1とする正規化座標」で持つ。表示倍率や
 *    レターボックス（object-contain の余白）に依存しない唯一の表現だから。
 *  - このコンポーネントは必ず「画像と同じ変形（拡大・パン）がかかる箱」の中に置くこと。
 *    外に置くと、拡大したときに枠だけが画像からずれる。
 *  - 逆に、検索ボタンや注意文は変形の外に置くこと（中に置くと拡大で文字が巨大化・画面外へ流れる）。
 */

/** プレビュー内の画像の描画位置（レターボックス込み・親が実測して渡す）。 */
export interface ImgLayout {
  ox: number;
  oy: number;
  dw: number;
  dh: number;
}

type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** 枠の最小サイズ（正規化）。これ以上小さいと掴めず、Vision へ送っても情報が足りない。 */
const MIN_SIZE = 0.05;

export function LensCropFrame({
  rect,
  onRectChange,
  imgLayout,
  toNormalized,
  disabled = false,
}: {
  rect: NormRect;
  onRectChange: (next: NormRect) => void;
  imgLayout: ImgLayout;
  /** 画面座標を画像内の正規化座標へ変換する（親の clientToNormalized をそのまま渡す）。 */
  toNormalized: (clientX: number, clientY: number) => { nx: number; ny: number } | null;
  /** 拡大中など、枠操作を止めたいとき。 */
  disabled?: boolean;
}) {
  // ドラッグ開始時の状態。move は掴んだ点と矩形左上のオフセットを保持する。
  const dragRef = useRef<null | { mode: DragMode; start: NormRect; grabX: number; grabY: number }>(null);
  // 最新の rect を参照するための箱（window リスナが古い値を掴まないように）。
  const rectRef = useRef(rect);
  rectRef.current = rect;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const n = toNormalized(e.clientX, e.clientY);
      if (!n) return;
      const s = d.start;

      if (d.mode === 'move') {
        onRectChange(clampRect({ ...s, x: n.nx - d.grabX, y: n.ny - d.grabY }, MIN_SIZE));
        return;
      }

      // 掴んだ辺だけを動かし、反対側の辺は固定する。
      let left = s.x;
      let top = s.y;
      let right = s.x + s.w;
      let bottom = s.y + s.h;
      if (d.mode.includes('w')) left = Math.min(n.nx, right - MIN_SIZE);
      if (d.mode.includes('e')) right = Math.max(n.nx, left + MIN_SIZE);
      if (d.mode.includes('n')) top = Math.min(n.ny, bottom - MIN_SIZE);
      if (d.mode.includes('s')) bottom = Math.max(n.ny, top + MIN_SIZE);
      onRectChange(clampRect({ x: left, y: top, w: right - left, h: bottom - top }, MIN_SIZE));
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onRectChange, toNormalized]);

  const startDrag = useCallback(
    (mode: DragMode) => (e: React.MouseEvent) => {
      if (disabled) return;
      const n = toNormalized(e.clientX, e.clientY);
      if (!n) return;
      const s = rectRef.current;
      dragRef.current = { mode, start: s, grabX: n.nx - s.x, grabY: n.ny - s.y };
      document.body.style.userSelect = 'none';
      e.preventDefault();
      // 下にある画像の onMouseDown（エリア編集の作図）へ伝えない。
      e.stopPropagation();
    },
    [disabled, toNormalized],
  );

  // 正規化座標 → プレビュー内のピクセル。矩形オーバーレイと同じ式（imgLayout 基準）。
  const px = {
    left: imgLayout.ox + rect.x * imgLayout.dw,
    top: imgLayout.oy + rect.y * imgLayout.dh,
    width: rect.w * imgLayout.dw,
    height: rect.h * imgLayout.dh,
  };

  const HANDLE = 14;
  const edges: Array<[DragMode, string, React.CSSProperties]> = [
    ['n', 'cursor-ns-resize', { top: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE }],
    ['s', 'cursor-ns-resize', { bottom: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE }],
    ['w', 'cursor-ew-resize', { left: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE }],
    ['e', 'cursor-ew-resize', { right: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE }],
    ['nw', 'cursor-nwse-resize', { top: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE, height: HANDLE }],
    ['ne', 'cursor-nesw-resize', { top: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE, height: HANDLE }],
    ['sw', 'cursor-nesw-resize', { bottom: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE, height: HANDLE }],
    ['se', 'cursor-nwse-resize', { bottom: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE, height: HANDLE }],
  ];

  return (
    <div
      data-testid="lens-crop-frame"
      className="absolute cursor-move"
      style={{
        ...px,
        // 枠の外側だけを暗くする常套手段。オーバーレイ用の div を4枚置くより
        // 継ぎ目が出ず、枠を動かしても常に画像全体を覆える。
        boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
      }}
      onMouseDown={startDrag('move')}
    >
      {/* 枠線と四隅のかぎ括弧（Google レンズと同じ見え方）。 */}
      <div className="pointer-events-none absolute inset-0 border border-white/70" />
      {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
        <div
          key={c}
          aria-hidden
          className={`pointer-events-none absolute h-5 w-5 border-white ${
            c === 'nw'
              ? 'left-0 top-0 border-l-[3px] border-t-[3px]'
              : c === 'ne'
                ? 'right-0 top-0 border-r-[3px] border-t-[3px]'
                : c === 'sw'
                  ? 'bottom-0 left-0 border-b-[3px] border-l-[3px]'
                  : 'bottom-0 right-0 border-b-[3px] border-r-[3px]'
          }`}
        />
      ))}
      {!disabled &&
        edges.map(([mode, cursor, style]) => (
          <div
            key={mode}
            role="presentation"
            aria-hidden
            data-crop-handle={mode}
            onMouseDown={startDrag(mode)}
            className={`absolute ${cursor} ${mode.length === 2 ? 'z-20' : 'z-10'}`}
            style={style}
          />
        ))}
    </div>
  );
}
