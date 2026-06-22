import React from 'react';
import { HelpCircle } from 'lucide-react';

type ModeId = 'sketch' | '3D' | 'ai';

type Props = {
  activeMode: ModeId;
  onSwitchToSketch: () => void;
  onSwitchTo3D: () => void;
  onSwitchToAi: () => void;
  canSwitchTo3D: boolean;
  canSwitchToAi?: boolean;
  aiDisabledTitle?: string;
  className?: string;
  /** 使い方ガイドを開く（260623: 上部に ? を置いて、一度きりでなく見返せるように）。 */
  onHelp?: () => void;
};

const shellClassName =
  'glass rounded-2xl border border-white/10 flex flex-wrap items-center gap-1 shadow-xl bg-black/40 backdrop-blur-md pointer-events-auto p-1.5';
const buttonBaseClassName =
  'inline-flex h-[34px] items-center justify-center px-4 rounded-xl text-[11px] font-black uppercase leading-none tracking-widest transition-all whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';
const activeClassName = 'bg-white text-black shadow-md';
const inactiveClassName = 'text-white/55 hover:text-white/95 focus-visible:text-white';

export function ModeToggleBar({
  activeMode,
  onSwitchToSketch,
  onSwitchTo3D,
  onSwitchToAi,
  canSwitchTo3D,
  canSwitchToAi = true,
  aiDisabledTitle,
  className,
  onHelp,
}: Props) {
  return (
    <div className={`${shellClassName}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        onClick={onSwitchToSketch}
        className={`${buttonBaseClassName} ${
          activeMode === 'sketch' ? activeClassName : inactiveClassName
        }`}
      >
        2Dビュー
      </button>
      <button
        type="button"
        onClick={onSwitchTo3D}
        disabled={!canSwitchTo3D}
        className={`${buttonBaseClassName} ${
          activeMode === '3D' ? activeClassName : inactiveClassName
        } disabled:opacity-20 disabled:cursor-not-allowed`}
      >
        3Dビュー
      </button>
      <button
        type="button"
        onClick={onSwitchToAi}
        disabled={!canSwitchToAi}
        title={!canSwitchToAi ? aiDisabledTitle : undefined}
        className={`${buttonBaseClassName} ${
          activeMode === 'ai' ? activeClassName : inactiveClassName
        } disabled:opacity-20 disabled:cursor-not-allowed`}
      >
        AI画像編集
      </button>
      {onHelp && (
        <button
          type="button"
          onClick={onHelp}
          title="使い方ガイド"
          aria-label="使い方ガイド"
          className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-xl text-white/55 transition-all hover:text-white/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <HelpCircle className="h-[18px] w-[18px]" />
        </button>
      )}
    </div>
  );
}
