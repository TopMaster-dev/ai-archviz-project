import React, { useCallback, useEffect, useRef } from 'react';
import type { FurnitureCatalogItem } from '../types.js';

/** `processedCatalog` の1件（App の handleAddFurniture に渡る形） */
export type FurnitureAssetStripItem = FurnitureCatalogItem & { [key: string]: unknown };

export type FurnitureCatalogFetchStatus = 'loading' | 'ready' | 'error';

export type FurnitureAssetStripProps = {
  processedCatalog: FurnitureAssetStripItem[];
  assetCategories: string[];
  selectedAssetCategory: string | null;
  onSelectedAssetCategoryChange: (category: string | null) => void;
  onPickItem: (item: FurnitureAssetStripItem) => void;
  renderThumbnail: (item: Pick<FurnitureAssetStripItem, 'url' | 'name'>) => React.ReactNode;
  /** 家具カタログ API の読み込み状態 */
  fetchStatus: FurnitureCatalogFetchStatus;
  /** fetchStatus が error のとき表示する短いメッセージ */
  fetchErrorMessage?: string | null;
  /** 「アップロード」カテゴリのパネル内「＋」から3Dモデルを追加する（260623）。 */
  onUploadModel?: () => void;
};

export const FurnitureAssetStrip: React.FC<FurnitureAssetStripProps> = ({
  processedCatalog,
  assetCategories,
  selectedAssetCategory,
  onSelectedAssetCategoryChange,
  onPickItem,
  renderThumbnail,
  fetchStatus,
  fetchErrorMessage,
  onUploadModel,
}) => {
  const barClass =
    'glass p-1.5 rounded-2xl border border-white/10 flex items-center gap-1.5 bg-black/40 backdrop-blur-xl shadow-2xl h-[72px]';

  // ホバーでポップアップを開閉するタイマー（260703(5) クライアント指摘③④）。
  // ③ カーソルが離れたら少し待って自動で閉じる（×不要）。バー↔ポップアップ間の隙間を跨ぐ猶予も兼ねる。
  // ④ 初回オープンは少し遅延させ、ドラッグ等で一瞬カテゴリに乗っただけでは開かないようにする（誤オープン防止）。
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearOpenTimer = () => {
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; }
  };
  const clearCloseTimer = () => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  };
  useEffect(() => () => { clearOpenTimer(); clearCloseTimer(); }, []);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => onSelectedAssetCategoryChange(null), 260);
  }, [onSelectedAssetCategoryChange]);

  const cancelClose = useCallback(() => clearCloseTimer(), []);

  // ホバーで開く。既に開いていれば即座にカテゴリ切替、閉じている場合のみ少し遅延して開く（誤オープン防止・④）。
  const hoverOpen = useCallback(
    (cat: string) => {
      clearCloseTimer();
      if (selectedAssetCategory) {
        clearOpenTimer();
        onSelectedAssetCategoryChange(cat);
        return;
      }
      clearOpenTimer();
      openTimerRef.current = setTimeout(() => onSelectedAssetCategoryChange(cat), 140);
    },
    [selectedAssetCategory, onSelectedAssetCategoryChange],
  );

  // クリックは即時トグル（保留中のタイマーは破棄）。
  const clickToggle = useCallback(
    (cat: string) => {
      clearOpenTimer();
      clearCloseTimer();
      onSelectedAssetCategoryChange(selectedAssetCategory === cat ? null : cat);
    },
    [selectedAssetCategory, onSelectedAssetCategoryChange],
  );

  if (fetchStatus === 'loading') {
    return (
      <div className="relative flex items-center gap-3 pointer-events-auto">
        <div className={`${barClass} px-4 justify-center min-w-[200px]`}>
          <span className="text-[10px] font-bold text-neutral-400 tracking-wide">家具カタログを読み込み中…</span>
        </div>
      </div>
    );
  }

  if (fetchStatus === 'error') {
    return (
      <div className="relative flex items-center gap-3 pointer-events-auto">
        <div className={`${barClass} px-4 justify-center min-w-[min(280px,88vw)] max-w-[min(360px,92vw)]`}>
          <span className="text-[9px] font-semibold text-red-300/95 leading-snug text-center">
            {fetchErrorMessage ?? '家具カタログを読み込めません'}
          </span>
        </div>
      </div>
    );
  }

  if (assetCategories.length === 0) {
    return (
      <div className="relative flex items-center gap-3 pointer-events-auto">
        <div className={`${barClass} px-4 justify-center min-w-[min(260px,88vw)] max-w-[min(400px,92vw)]`}>
          <span className="text-[9px] font-semibold text-amber-200/85 leading-snug text-center">
            家具データがありません。Cloudinary のフォルダ「3d_assets」にモデルがあるか確認してください。
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex items-center gap-3 pointer-events-auto"
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      {selectedAssetCategory && (
        <div className="absolute bottom-[calc(100%+16px)] right-0 w-[min(90vw,360px)] glass p-4 rounded-3xl border border-white/10 bg-black/80 backdrop-blur-2xl shadow-2xl animate-in fade-in slide-in-from-bottom-2 safe-r">
          <div className="flex justify-between items-center mb-3 px-1">
            <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">{selectedAssetCategory}</span>
            <button
              type="button"
              onClick={() => onSelectedAssetCategoryChange(null)}
              className="text-white/50 hover:text-white transition-colors"
              aria-label="閉じる"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2 max-h-[300px] overflow-y-auto pr-1 scroll-dark">
            {selectedAssetCategory === 'アップロード' && onUploadModel && (
              <button
                type="button"
                onClick={onUploadModel}
                className="aspect-square rounded-2xl bg-emerald-600/90 border border-emerald-500 text-white hover:bg-emerald-500 transition-all flex flex-col items-center justify-center gap-0.5"
                title="3Dモデルを追加（.glb / .gltf / .fbx / .obj）"
              >
                <span className="text-2xl font-black leading-none">＋</span>
                <span className="text-[8px] font-bold leading-none">3D追加</span>
              </button>
            )}
            {processedCatalog
              .filter((item) => item.type === selectedAssetCategory)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onPickItem(item);
                    onSelectedAssetCategoryChange(null);
                  }}
                  className="aspect-square rounded-2xl bg-neutral-800/80 border border-white/10 text-white hover:border-emerald-500 hover:bg-neutral-700 transition-all overflow-hidden relative group"
                  title={item.name}
                >
                  <div className="absolute inset-0 opacity-80 group-hover:opacity-100 group-hover:scale-110 transition-all duration-500">
                    {renderThumbnail({ url: item.url, name: item.name })}
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/10 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-2xl font-black text-emerald-400 drop-shadow-md">+</span>
                  </div>
                </button>
              ))}
          </div>
        </div>
      )}

      <div className={barClass}>
        {assetCategories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => clickToggle(cat)}
            // 260623: マウスオーバーで自動的にパネルを立ち上げる（クリック不要で一覧を出す）。
            // 260703(5): 初回は少し遅延して開き、離れたら自動で閉じる（③④）。
            onMouseEnter={() => hoverOpen(cat)}
            // ボタンから隙間（gap の余白）へ抜けたら保留中のオープンを取消（閉じている時のみ・誤オープンの残路を塞ぐ）。
            // 既に開いている場合は切替に遅延を使わないため触らない（自動クローズはコンテナ側 onMouseLeave が担当）。
            onMouseLeave={() => { if (!selectedAssetCategory) clearOpenTimer(); }}
            className={`h-full w-[60px] rounded-xl border transition-all flex flex-col items-center justify-center gap-1 group ${
              selectedAssetCategory === cat
                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-inner'
                : cat === 'アップロード'
                  ? 'bg-emerald-600/90 border-emerald-500 text-white hover:bg-emerald-500'
                  : 'bg-neutral-800/80 border-white/10 text-white hover:border-white/30'
            }`}
          >
            <span className="text-[10px] font-black uppercase tracking-widest">{cat}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
