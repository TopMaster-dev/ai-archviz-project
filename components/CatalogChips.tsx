import React from 'react';

/**
 * カタログのカテゴリ／ブランド用チップ（260731 クライアント要望）。
 *
 * 建材カタログと3Dモデルカタログでボタンの形・大きさが揃っていなかったため、
 * 見た目の定義をここ1か所へ集約する。3つの行（建材の面カテゴリ／建材のブランド／
 * 3Dモデルのカテゴリ）が同じ関数を使うので、片方だけ直してずれることが起きない。
 * 2Dビューの右レールも同じ ModelCatalogRail を使うため自動的に揃う。
 */

/**
 * カタログの左右余白（260731 クライアント要望②）。
 *
 * カテゴリ行は「スクロールしない上部」、一覧は「スクロールする下部」と別の箱に分かれた。
 * 別の箱になった以上、余白を別々に書くと必ずどちらかがずれる（＝タブ切替や
 * スクロールで左端が動いて見える）。建材／3Dモデルの両方がここを参照すること。
 */
export const CATALOG_PAD_X = 'px-6 md:px-8';
/** 一覧側の下余白。最後の行が使用中パネルの境界に貼り付かないようにする。 */
export const CATALOG_PAD_B = 'pb-6 md:pb-8';

/**
 * チップのクラス。
 * @param active 選択中か。
 * @param accent 「アップロード」など、常に緑で目立たせる枠か。
 */
export function catalogChipClass(opts: { active: boolean; accent?: boolean }): string {
  const base =
    'shrink-0 whitespace-nowrap rounded-xl border px-4 py-2.5 text-[10px] font-black uppercase transition-all';
  if (opts.accent) {
    // 形と大きさは他と同じまま、色だけ緑。選択中も緑のまま（白へ反転すると他と紛れる）。
    return `${base} ${
      opts.active
        ? 'border-emerald-300 bg-emerald-500 text-white shadow-[0_0_0_2px_rgba(16,185,129,0.35)]'
        : 'border-emerald-500 bg-emerald-600/90 text-white hover:bg-emerald-500'
    }`;
  }
  return `${base} ${
    opts.active
      ? 'border-white bg-white text-black shadow-lg'
      : 'border-white/5 bg-[#111] text-neutral-500 hover:border-white/20 hover:text-white'
  }`;
}

/**
 * チップの1行。左端に固定するチップ（アップロード等）と、横スクロールする残りを受け取る。
 *
 * スクロールバーは隠さない。隠すと「まだ右にチップがある」ことに気付けないうえ、
 * 固定チップとの区切り線でリストが終わったように見える（260728/260730 クライアント指摘）。
 */
export function CatalogChipRow({
  pinned,
  children,
  testId,
}: {
  pinned?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="-mx-2 flex items-start gap-2 px-2">
      {pinned && (
        <>
          {pinned}
          <div className="h-9 w-px shrink-0 self-center bg-white/15" aria-hidden />
        </>
      )}
      <div data-testid={testId} className="scroll-dark flex min-w-0 flex-1 gap-2 overflow-x-auto pb-2">
        {children}
      </div>
    </div>
  );
}
