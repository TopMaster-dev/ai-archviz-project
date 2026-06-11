/**
 * ドアの開き方向コントロール（向き：左右反転 / 内外反転）。
 * 2Dビューと3Dビューで同一のコンポーネントを使い、見た目・挙動を完全に一致させる。
 * 状態は opening.swingFlipX / swingFlipY（共有ストア）であり、どちらのビューから操作しても両方へ反映される。
 */
export function DoorSwingControls({
  swingFlipX,
  swingFlipY,
  onToggleX,
  onToggleY,
}: {
  swingFlipX?: boolean;
  swingFlipY?: boolean;
  onToggleX: () => void;
  onToggleY: () => void;
}) {
  const btnClass = (active?: boolean) =>
    `flex-1 rounded-lg border px-2 py-1 text-[10px] transition-colors ${
      active
        ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
        : 'border-white/15 bg-black/40 text-white hover:border-emerald-500/50'
    }`;

  return (
    <div className="flex items-center gap-2 w-full min-w-0">
      <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-10">向き</span>
      <button type="button" onClick={onToggleX} className={btnClass(swingFlipX)} title="吊り元（左右）を反転">
        左右反転
      </button>
      <button type="button" onClick={onToggleY} className={btnClass(swingFlipY)} title="開く向き（内外）を反転">
        内外反転
      </button>
    </div>
  );
}
