import React, { useMemo, useState } from 'react';
import { LayoutGrid, Square } from 'lucide-react';
import { catalogChipClass, CatalogChipRow, CATALOG_PAD_X, CATALOG_PAD_B } from './CatalogChips.js';
import type { FurnitureCatalogItem } from '../types.js';

/**
 * 3Dモデルカタログ（右サイドパネル版・260730 クライアント要望②）。
 *
 * 従来は画面下に浮かぶ横長パネル（3Dオブジェクト）だったが、作業領域を覆いすぎるという指摘により
 * 建材カタログと同じ右レールへ移した。見た目・操作感は建材カタログに合わせること（クライアント要望）。
 * そのため列数のスライダーは建材側と同じ state（catalogGridSize）を親から受け取り、
 * カテゴリのチップも建材側と同じクラスを使う。
 */

/** 「アップロード」カテゴリ名。App のカテゴリ生成（lib/uploadsCatalog の UPLOAD_FURNITURE_TYPE）と一致させること。 */
export const UPLOAD_CATEGORY = 'アップロード';

/** 全カテゴリ横断タブ。カテゴリ一覧の先頭に置き、選択時は絞り込まず全件を出す。 */
export const ALL_CATEGORY = 'ALL';

export type FurnitureCatalogRailItem = FurnitureCatalogItem & { [key: string]: unknown };
export type FurnitureCatalogFetchStatus = 'loading' | 'ready' | 'error';

/**
 * 3Dモデル1件のタイル（260731 クライアント要望①②）。
 *
 * カタログと「使用中の3Dモデル」で必ず同じ見た目・同じ動作にするため、描画はここ1か所だけ。
 * 押すとどちらからでも同じように配置される。
 */
export function ModelCatalogTile({
  item,
  onPick,
  renderThumbnail,
}: {
  item: Pick<FurnitureCatalogItem, 'name'>;
  onPick: () => void;
  renderThumbnail: () => React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={item.name}
      // サムネイル背景はアイボリー（260729 要望⑤・色は index.css の --thumb-bg）。
      className="group relative aspect-square overflow-hidden rounded-2xl border border-white/10 bg-[var(--thumb-bg)] text-white transition-all hover:border-emerald-500 hover:bg-[var(--thumb-bg-hover)]"
    >
      <div className="absolute inset-0 opacity-90 transition-all duration-500 group-hover:scale-105 group-hover:opacity-100">
        {renderThumbnail()}
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/10 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="text-2xl font-black text-emerald-400 drop-shadow-md">+</span>
      </div>
    </button>
  );
}

export function ModelCatalogRail({
  items,
  categories,
  selectedCategory,
  onSelectCategory,
  gridSize,
  onGridSizeChange,
  sliderToGrid,
  gridToSlider,
  onPickItem,
  renderThumbnail,
  fetchStatus,
  fetchErrorMessage,
  onUploadModel,
}: {
  items: FurnitureCatalogRailItem[];
  categories: string[];
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
  /** 建材カタログと共有する列数の状態（見た目を揃えるため同じ値を使う）。 */
  gridSize: number;
  onGridSizeChange: (next: number) => void;
  sliderToGrid: Record<number, number>;
  gridToSlider: Record<number, number>;
  onPickItem: (item: FurnitureCatalogRailItem) => void;
  renderThumbnail: (
    item: Pick<FurnitureCatalogRailItem, 'url' | 'name' | 'modelUprightXDeg' | 'forwardYawDeg' | 'thumbnailUrl'>,
  ) => React.ReactNode;
  fetchStatus: FurnitureCatalogFetchStatus;
  fetchErrorMessage?: string | null;
  /** 「アップロード」カテゴリの先頭に出す「＋」タイル。未指定なら出さない。 */
  onUploadModel?: () => void;
}) {
  /*
   * 列数は「スライダーの位置」から決める（260730 クライアント要望: 左から 小→中→大→最大）。
   *
   * 建材カタログと同じ式（5 - gridSize）にしてはいけない。あちらは1列のとき
   * 「1列のタイル」ではなく「リスト行（小さいサムネイル＋文字）」を描くため、
   * 1列＝最小として成立している。こちらは1列＝画面いっぱいの大きなタイル＝最大なので、
   * 同じ式を使うと目盛りの左端だけが最大になり「最大→小→中→大」という並びになる。
   *
   * スライダー位置 1→4列(小) / 2→3列(中) / 3→2列(大) / 4→1列(最大)。
   * state（gridSize）は建材側と共有したままなので、どちらのタブでも
   * 「左ほど小さく、右ほど大きい」で一致する。
   */
  const sliderPos = gridToSlider[gridSize] ?? 2;
  const cols = Math.max(1, 5 - sliderPos);

  const visibleItems = useMemo(() => {
    if (selectedCategory === ALL_CATEGORY) return items;
    return items.filter((it) => it.type === selectedCategory);
  }, [items, selectedCategory]);

  // 「アップロード」は左端固定、それ以外だけを横スクロールさせる（260730 クライアント要望）。
  const uploadCategory = categories.includes(UPLOAD_CATEGORY) ? UPLOAD_CATEGORY : null;
  const scrollableCategories = categories.filter((c) => c !== UPLOAD_CATEGORY);

  /** カテゴリボタン1個（固定枠とスクロール枠の両方で使うので、形は必ずここ1か所で決める）。 */
  const renderCategoryButton = (cat: string) => {
    const active = selectedCategory === cat;
    const isUpload = cat === UPLOAD_CATEGORY;
    return (
      <button
        key={cat}
        type="button"
        aria-pressed={active}
        onClick={() => onSelectCategory(cat)}
        className={catalogChipClass({ active, accent: isUpload })}
      >
        {cat}
      </button>
    );
  };

  if (fetchStatus === 'loading') {
    return (
      <div className={`grid grid-cols-3 gap-2 pt-2 ${CATALOG_PAD_X}`}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-square animate-pulse rounded-xl bg-white/5" />
        ))}
      </div>
    );
  }
  if (fetchStatus === 'error') {
    return (
      <div className={CATALOG_PAD_X}>
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-4 text-[11px] font-bold text-red-300">
          3Dモデルの読み込みに失敗しました。
          {fetchErrorMessage ? <span className="block text-[10px] text-red-400/80">{fetchErrorMessage}</span> : null}
        </div>
      </div>
    );
  }

  return (
    /*
      上部（サイズ調整＋カテゴリ）は固定、一覧だけがスクロールする（260731 クライアント要望②）。
      以前は全体が1つのスクロール箱に入っていたため、モデルを探して下へスクロールすると
      カテゴリのチップが画面外へ流れ、カテゴリを変えるたびに一番上まで戻る必要があった。

      position: sticky ではなく箱を分ける方式にしている。チップ行自体が横スクロールを持つので、
      sticky にすると縦横2つのスクロール文脈が重なって、端末によって張り付きが崩れるため。
    */
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div data-testid="model-catalog-header" className={`shrink-0 ${CATALOG_PAD_X}`}>
        {/* サムネ表示密度（建材カタログと同じ操作・同じ見た目にそろえる）。 */}
        <div className="mb-2 flex flex-wrap items-center justify-end gap-3">
          {/* 左端＝細かいマス（小さく多く）、右端＝1マス（最大）。目盛りの向きと絵を一致させる。 */}
          <div className="flex min-w-0 items-center gap-2" title="左: 小さい → 右: 最大">
            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden />
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={gridToSlider[gridSize] ?? 2}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v)) return;
                const next = sliderToGrid[Math.min(4, Math.max(1, v))];
                if (next !== undefined) onGridSizeChange(next);
              }}
              className="catalog-thumb-size-slider h-1 w-[88px] shrink-0 cursor-pointer accent-emerald-500"
              aria-label="サムネイルの大きさ"
            />
            <Square className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden />
          </div>
        </div>

        {/*
          カテゴリ（建材カタログのチップと同じ形・同じ大きさ）。
          「アップロード」だけは横スクロールの外に出して左端へ固定する（260730 クライアント要望）。
          カテゴリが増えて右へスクロールしても、自分がアップロードしたモデルへは常に1クリックで戻れる。
          色は他と揃えた形のまま緑にして、「自分の資産」であることが一目で分かるようにする。
        */}
        <div className="mb-3">
          <CatalogChipRow
            testId="category-scroller"
            pinned={uploadCategory ? renderCategoryButton(uploadCategory) : undefined}
          >
            {scrollableCategories.map((cat) => renderCategoryButton(cat))}
          </CatalogChipRow>
        </div>
      </div>

      <div
        data-testid="model-catalog-scroller"
        className={`scroll-dark min-h-0 flex-1 overflow-y-auto ${CATALOG_PAD_X} ${CATALOG_PAD_B}`}
      >
        <div
          data-testid="model-catalog-grid"
          className="grid gap-2"
          style={{ gridTemplateColumns: cols === 1 ? '1fr' : `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {selectedCategory === UPLOAD_CATEGORY && onUploadModel && (
            <button
              type="button"
              onClick={onUploadModel}
              className="flex aspect-square flex-col items-center justify-center gap-0.5 rounded-2xl border border-emerald-500 bg-emerald-600/90 text-white transition-all hover:bg-emerald-500"
              title="3Dモデルを追加（.glb / .gltf / .fbx / .obj）"
            >
              <span className="text-2xl font-black leading-none">＋</span>
              <span className="text-[8px] font-bold leading-none">3D追加</span>
            </button>
          )}
          {visibleItems.map((item) => (
            <ModelCatalogTile
              key={item.id}
              item={item}
              onPick={() => onPickItem(item)}
              renderThumbnail={() =>
                renderThumbnail({
                  url: item.url,
                  name: item.name,
                  modelUprightXDeg: item.modelUprightXDeg,
                  forwardYawDeg: item.forwardYawDeg,
                  thumbnailUrl: item.thumbnailUrl,
                })
              }
            />
          ))}
        </div>
        {visibleItems.length === 0 && selectedCategory !== UPLOAD_CATEGORY && (
          <div className="rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-[10px] font-bold text-neutral-500">
            このカテゴリには3Dモデルがありません
          </div>
        )}
      </div>
    </div>
  );
}
