import React from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, RotateCw, Crosshair } from 'lucide-react';

type WalkInput = { forward: number; strafe: number; rotate: number; reset: boolean };

interface WalkMovePadProps {
  disabled: boolean;
  walkDigitalInputRef: React.MutableRefObject<WalkInput>;
  className?: string;
}

// 3D ウォークの移動操作パネル。前後左右の移動に加え、左右旋回（Q/E 相当）と
// 「視点を正面に戻す」（マウスホイールクリック相当）をボタンでも操作できる（260630 クライアント要望）。
export const WalkMovePad: React.FC<WalkMovePadProps> = ({ disabled, walkDigitalInputRef, className = '' }) => {
  const patch = (p: Partial<WalkInput>) => {
    walkDigitalInputRef.current = { ...walkDigitalInputRef.current, ...p };
  };
  // 押下中だけ作用する移動/旋回（離す・離脱で 0 に戻す）。
  const stop = () => patch({ forward: 0, strafe: 0, rotate: 0 });
  const hold = (p: Partial<WalkInput>) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      patch(p);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
  });
  const btnCls =
    'tap flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/15 disabled:opacity-30 focus-ring';
  const iconCls = 'w-4 h-4 text-white/80';

  return (
    <div
      className={`grid grid-cols-3 gap-1 shrink-0 p-1.5 rounded-xl border border-white/10 bg-black/45 backdrop-blur-md shadow-xl pointer-events-auto ${className}`}
      onPointerLeave={stop}
    >
      {/* 1段目: 左旋回 / 前進 / 右旋回 */}
      <button type="button" disabled={disabled} title="左に旋回（Q）" className={btnCls} {...hold({ rotate: 1 })}>
        <RotateCcw className={iconCls} />
      </button>
      <button type="button" disabled={disabled} title="前進（W / ↑）" className={btnCls} {...hold({ forward: 1 })}>
        <ChevronUp className={iconCls} />
      </button>
      <button type="button" disabled={disabled} title="右に旋回（E）" className={btnCls} {...hold({ rotate: -1 })}>
        <RotateCw className={iconCls} />
      </button>

      {/* 2段目: 左移動 / 視点を正面に戻す / 右移動 */}
      <button type="button" disabled={disabled} title="左へ（A / ←）" className={btnCls} {...hold({ strafe: -1 })}>
        <ChevronLeft className={iconCls} />
      </button>
      <button
        type="button"
        disabled={disabled}
        title="視点を正面に戻す（水平）"
        className={btnCls}
        onClick={() => patch({ reset: true })}
      >
        <Crosshair className={iconCls} />
      </button>
      <button type="button" disabled={disabled} title="右へ（D / →）" className={btnCls} {...hold({ strafe: 1 })}>
        <ChevronRight className={iconCls} />
      </button>

      {/* 3段目: 後退（中央のみ） */}
      <span />
      <button type="button" disabled={disabled} title="後退（S / ↓）" className={btnCls} {...hold({ forward: -1 })}>
        <ChevronDown className={iconCls} />
      </button>
      <span />
    </div>
  );
};
