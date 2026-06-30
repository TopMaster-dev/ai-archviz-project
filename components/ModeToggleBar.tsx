import React from 'react';
import { Home, Loader2 } from 'lucide-react';

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
  /** ホームへ戻る（260623: 2D/3D/AI で配置を共通化。モードバー左端に「ホーム」を置く）。
      未指定（ゲスト等）のときは「ホーム」を出さない。 */
  onGoHome?: () => void;
  /** 離脱時オートセーブ中（ホーム遷移処理中）は「保存中…」表示＋無効化。 */
  homeBusy?: boolean;
};

const shellClassName =
  'glass rounded-2xl border border-white/10 flex flex-wrap items-center gap-1 shadow-xl bg-black/40 backdrop-blur-md pointer-events-auto p-1.5';
const buttonBaseClassName =
  'inline-flex h-[34px] items-center justify-center px-4 rounded-xl text-[11px] font-black uppercase leading-none tracking-widest transition-all whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';
const activeClassName = 'bg-white text-black shadow-md';
const inactiveClassName = 'text-white/55 hover:text-white/95 focus-visible:text-white';
// 「ホーム」ボタンは全ビューで統一の緑（emerald）。モード切替タブと色で区別し、視認性を上げる（260624）。
const homeClassName = 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 hover:text-emerald-100';

export function ModeToggleBar({
  activeMode,
  onSwitchToSketch,
  onSwitchTo3D,
  onSwitchToAi,
  canSwitchTo3D,
  canSwitchToAi = true,
  aiDisabledTitle,
  className,
  onGoHome,
  homeBusy,
}: Props) {
  return (
    <div className={`${shellClassName}${className ? ` ${className}` : ''}`}>
      {onGoHome && (
        <>
          <button
            type="button"
            onClick={onGoHome}
            disabled={homeBusy}
            title="ホームに戻る（プロジェクト一覧）"
            className={`${buttonBaseClassName} ${homeClassName} gap-1.5 disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {homeBusy ? (
              <Loader2 className="h-[15px] w-[15px] animate-spin" />
            ) : (
              <Home className="h-[15px] w-[15px]" />
            )}
            {homeBusy ? '保存中…' : 'ホーム'}
          </button>
          <div className="mx-0.5 h-5 w-px self-center bg-white/15" aria-hidden />
        </>
      )}
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
    </div>
  );
}
