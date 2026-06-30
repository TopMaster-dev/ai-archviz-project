import { HelpCircle } from 'lucide-react';

/**
 * 使い方ガイドを開く独立した「?」ボタン（260630 クライアント要望）。
 * 「ホーム/2D/3D/AI画像編集」トグルから切り離し、エディタ各ビュー（2D/3D/AI）共通でトグルの隣に置く。
 * 見た目はホーム画面の「?」に合わせる（rounded-md / bg-neutral-800 / HelpCircle）。
 */
export function EditorHelpButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="使い方ガイド"
      aria-label="使い方ガイド"
      className="pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 text-neutral-300 shadow-lg ring-1 ring-white/10 transition hover:bg-neutral-700 hover:text-white"
    >
      <HelpCircle className="h-[18px] w-[18px]" />
    </button>
  );
}
