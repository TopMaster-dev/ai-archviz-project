import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, LayoutList } from 'lucide-react';
import type { FurnitureCatalogItem } from '../types.js';

/**
 * 「アップロード」カテゴリ名。App のカテゴリ生成（lib/uploadsCatalog の UPLOAD_FURNITURE_TYPE）と
 * 必ず同じ文字列であること。以前は本ファイル内で生の文字列リテラルを別々に書いており、
 * どちらか一方だけ直すと「＋」タイルが黙って消える状態だった。
 */
export const UPLOAD_CATEGORY = 'アップロード';

/**
 * 全カテゴリ横断タブ（260729 クライアント要望④）。
 * カテゴリ一覧の先頭に置き、選択時はカテゴリで絞り込まずカタログ全件を出す。
 */
export const ALL_CATEGORY = 'ALL';

/** サムネイルサイズのスライダー位置（1=小さく多列 … 4=大きく少列）→ グリッドの列数（260729 要望②）。 */
const THUMB_SIZE_TO_COLUMNS: Record<number, number> = { 1: 6, 2: 4, 3: 3, 4: 2 };
const DEFAULT_THUMB_SIZE = 2; // 従来と同じ4列
const THUMB_SIZE_STORAGE_KEY = 'arise.asset-strip.thumb-size.v1';

function loadThumbSize(): number {
  try {
    const v = parseInt(localStorage.getItem(THUMB_SIZE_STORAGE_KEY) ?? '', 10);
    return THUMB_SIZE_TO_COLUMNS[v] ? v : DEFAULT_THUMB_SIZE;
  } catch {
    return DEFAULT_THUMB_SIZE;
  }
}

/** `processedCatalog` の1件（App の handleAddFurniture に渡る形） */
export type FurnitureAssetStripItem = FurnitureCatalogItem & { [key: string]: unknown };

export type FurnitureCatalogFetchStatus = 'loading' | 'ready' | 'error';

export type FurnitureAssetStripProps = {
  processedCatalog: FurnitureAssetStripItem[];
  assetCategories: string[];
  selectedAssetCategory: string | null;
  onSelectedAssetCategoryChange: (category: string | null) => void;
  onPickItem: (item: FurnitureAssetStripItem) => void;
  renderThumbnail: (item: Pick<FurnitureAssetStripItem, 'url' | 'name' | 'modelUprightXDeg' | 'forwardYawDeg' | 'thumbnailUrl'>) => React.ReactNode;
  /** 家具カタログ API の読み込み状態 */
  fetchStatus: FurnitureCatalogFetchStatus;
  /** fetchStatus が error のとき表示する短いメッセージ */
  fetchErrorMessage?: string | null;
  /** 「アップロード」カテゴリのパネル内「＋」から3Dモデルを追加する（260623）。 */
  onUploadModel?: () => void;
  /** ルートに足すクラス。パネルをリサイズしたとき中身を追従させる用（h-full w-full・260729 要望①）。 */
  className?: string;
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
  className = '',
}) => {
  const barClass =
    // パネルの枠に追従させる（w-full/h-full）。呼び出し側は必ず高さの定まった箱に入れること
    // （MovablePanel には defaultHeight を渡す）。高さが auto の箱に入れると h-full が auto に解決され、
    // 中のカテゴリボタンの h-full まで潰れる（敵対レビュー #8）。min-h は単体配置時の保険。
    'glass p-1.5 rounded-2xl border border-white/10 flex items-center gap-1.5 bg-black/40 backdrop-blur-xl shadow-2xl h-full min-h-[72px] w-full';

  // ホバー中のカテゴリボタンの真上にポップアップを出すためのアンカー（260727 クライアント要望）。
  // コンテナ基準の絶対配置（親の transform 有無に依存しない）。left はコンテナ内でクランプして端でもはみ出さない。
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [anchorPos, setAnchorPos] = useState<{ left: number; width: number } | null>(null);

  // サムネイル表示サイズ（260729 クライアント要望②）。スライダー位置1〜4を列数へ写す。
  // 端末をまたいでも設定が残るよう localStorage に保存する（右レールの建材カタログは
  // 同種のスライダーを持つが保存していないため、リロードで既定に戻る）。
  const [thumbSize, setThumbSize] = useState<number>(loadThumbSize);
  useEffect(() => {
    try {
      localStorage.setItem(THUMB_SIZE_STORAGE_KEY, String(thumbSize));
    } catch {
      /* 保存不可（プライベートモード等）でも動作は続ける */
    }
  }, [thumbSize]);
  const gridColumns = THUMB_SIZE_TO_COLUMNS[thumbSize] ?? THUMB_SIZE_TO_COLUMNS[DEFAULT_THUMB_SIZE];

  // ポップアップ幅（アンカー未測定時のフォールバックと共通化）。下の grid 高さ計算と必ず同じ値を使う。
  const popupWidthCss = anchorPos ? `${anchorPos.width}px` : 'min(90vw, 360px)';
  // サムネイル一覧は「最大2行、3行目以降はスクロール」（260728 クライアント要望 #7・3Dモデル増加への備え）。
  // 固定分 = p-4×2(32) + pr-1(4) + スクロールバー(8) = 44、これに gap(8)×(列数−1) を足したものが
  // セル幅に使えない分。1セル = (幅 − 固定分 − gap合計) / 列数、2行の高さ = セル×2 + gap(8)。
  // 列数から導出するので、サイズスライダーで列数が変わっても「2行ぶん」が崩れない
  // （従来は 4 列決め打ちの 68px がハードコードされていた）。
  const gridChromePx = 44 + 8 * (gridColumns - 1);
  const gridMaxHeight = `calc((${popupWidthCss} - ${gridChromePx}px) / ${gridColumns} * 2 + 8px)`;
  const measureAnchor = useCallback((el: HTMLElement | null) => {
    const c = containerRef.current;
    if (!c || !el) {
      setAnchorPos(null);
      return;
    }
    const cr = c.getBoundingClientRect();
    const br = el.getBoundingClientRect();
    // getBoundingClientRect は親の transform: scale 込みの「画面px」を返すが、ここで決めた left/width は
    // CSS のレイアウトpxとして書き戻される。倍率を割らないと、パネルを拡大しているときだけ
    // ポップアップの位置と幅がずれる（敵対レビュー #6）。offsetWidth はレイアウトpxなので比で倍率が出る。
    const s = c.offsetWidth ? cr.width / c.offsetWidth : 1;
    const containerW = (cr.width || 340) / (s || 1);
    const centerX = (br.left - cr.left + br.width / 2) / (s || 1); // コンテナ内でのボタン中心（レイアウトpx）
    // パネルを広げたぶんだけポップアップも広げる（＝サムネイルを大きく/多く出せる）。
    // 従来は 340px 固定で、パネルを広げても一覧が広がらず要望①の意味が無かった（敵対レビュー #7）。
    const width = Math.min(containerW, 760);
    // ポップアップ幅がコンテナからはみ出さないよう左位置をクランプ（中央=translateX(-50%)前提）。
    const left = Math.max(width / 2, Math.min(containerW - width / 2, centerX));
    setAnchorPos({ left, width });
  }, []);

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
  // ホバーした要素の位置を測ってポップアップをその真上に出す（260727）。
  const hoverOpen = useCallback(
    (cat: string, el: HTMLElement) => {
      measureAnchor(el);
      clearCloseTimer();
      if (selectedAssetCategory) {
        clearOpenTimer();
        onSelectedAssetCategoryChange(cat);
        return;
      }
      clearOpenTimer();
      openTimerRef.current = setTimeout(() => onSelectedAssetCategoryChange(cat), 140);
    },
    [selectedAssetCategory, onSelectedAssetCategoryChange, measureAnchor],
  );

  // クリックは即時トグル（保留中のタイマーは破棄）。
  const clickToggle = useCallback(
    (cat: string, el: HTMLElement) => {
      measureAnchor(el);
      clearOpenTimer();
      clearCloseTimer();
      onSelectedAssetCategoryChange(selectedAssetCategory === cat ? null : cat);
    },
    [selectedAssetCategory, onSelectedAssetCategoryChange, measureAnchor],
  );

  /**
   * 一度に見せるカテゴリ数（260728 クライアント要望「5個以上なら5個だけ表示して横スクロール」）。
   * 「アップロード」は右端固定なのでこの数に含めない。
   */
  const VISIBLE_CATEGORY_COUNT = 5;
  const uploadCategory = assetCategories.includes(UPLOAD_CATEGORY) ? UPLOAD_CATEGORY : null;
  const scrollableCategories = assetCategories.filter((c) => c !== UPLOAD_CATEGORY);

  /**
   * ハイライトするカテゴリ（260729 クライアント要望④）。
   *
   * selectedAssetCategory は「どのポップアップが開いているか」も兼ねており、閉じると null になる。
   * そのためハイライトを selectedAssetCategory だけで決めると、パネルを閉じた瞬間に
   * どのカテゴリも光らなくなる＝「今どれを見ているのか分からない」という今回の指摘そのものになる。
   * 開いている間は開いているカテゴリを、閉じたら最後に選んだカテゴリを光らせ続ける。
   */
  const [stickyCategory, setStickyCategory] = useState<string>(ALL_CATEGORY);
  useEffect(() => {
    if (selectedAssetCategory) setStickyCategory(selectedAssetCategory);
  }, [selectedAssetCategory]);
  const highlightedCategory = selectedAssetCategory ?? stickyCategory;

  /** ポップアップに並べる品目。ALL はカテゴリで絞らず全件（アップロード分も含む）。 */
  const visibleItems = useMemo(() => {
    if (!selectedAssetCategory) return [];
    if (selectedAssetCategory === ALL_CATEGORY) return processedCatalog;
    return processedCatalog.filter((item) => item.type === selectedAssetCategory);
  }, [processedCatalog, selectedAssetCategory]);

  /**
   * スクロールできることが一目で分かるようにするための状態（260728 クライアント指摘）。
   * スクロールバーを隠している（高さ72pxのバーでは太すぎてボタンが潰れる）ので、
   * 代わりに「現在位置を示す細いインジケータ」と「左右の矢印ボタン」を出す。
   */
  const [scrollState, setScrollState] = useState({
    overflowing: false,
    atStart: true,
    atEnd: true,
    thumbPct: 100,
    thumbLeftPct: 0,
  });
  const updateScrollState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const overflow = scrollWidth - clientWidth;
    if (overflow <= 1) {
      setScrollState({ overflowing: false, atStart: true, atEnd: true, thumbPct: 100, thumbLeftPct: 0 });
      return;
    }
    // つまみは「見えている割合」。細くなり過ぎると掴みどころが無いので最低12%は確保する。
    const thumbPct = Math.max(12, (clientWidth / scrollWidth) * 100);
    const leftPct = (scrollLeft / scrollWidth) * 100;
    setScrollState({
      overflowing: true,
      atStart: scrollLeft <= 1,
      atEnd: scrollLeft >= overflow - 1,
      thumbPct,
      thumbLeftPct: Math.min(100 - thumbPct, leftPct),
    });
  }, []);

  /** 矢印ボタン: 見えている幅の約6割ぶん送る（1ボタンずつだと遅く、全幅だと飛びすぎる）。 */
  const scrollByStep = useCallback((dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.6), behavior: 'smooth' });
  }, []);

  // 5個ぶんの実幅を測ってスクロール領域の上限にする（260728）。
  // ボタンは内容に合わせた可変幅（長い名称を折り返さないため・260727）なので、固定幅では
  // 「カウンターチェア」のような長い名称が切れてしまう。実測なら文字を削らずちょうど5個で切れる。
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollerMaxWidth, setScrollerMaxWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const kids = Array.from(el.children) as HTMLElement[];
      // 5個以下なら制限しない（スクロールバーも区切り線も出さない）。
      if (kids.length <= VISIBLE_CATEGORY_COUNT) {
        setScrollerMaxWidth(null);
        return;
      }
      const first = kids[0];
      const last = kids[VISIBLE_CATEGORY_COUNT - 1];
      if (!first || !last) return;
      // 先頭の左端〜5個目の右端。スクロール位置に依らず一定（両者は一緒に動く）。
      const width = last.getBoundingClientRect().right - first.getBoundingClientRect().left;
      if (width > 0) setScrollerMaxWidth(Math.ceil(width));
    };
    const run = () => {
      measure();
      updateScrollState();
    };
    run();
    // フォント読み込みやカテゴリ増減で幅が変わるので追従する。
    const ro = new ResizeObserver(run);
    ro.observe(el);
    for (const k of Array.from(el.children)) ro.observe(k as HTMLElement);
    return () => ro.disconnect();
  }, [scrollableCategories.join('|'), updateScrollState]);

  // maxWidth が確定した直後にも状態を取り直す（初回は制限前の幅で測ってしまうため）。
  useLayoutEffect(() => {
    updateScrollState();
  }, [scrollerMaxWidth, updateScrollState]);

  /** 縦ホイールを横スクロールへ（トラックパッド以外でも送れるように）。 */
  const handleScrollerWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return; // はみ出していなければ何もしない
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 既に横スクロール操作
    el.scrollLeft += e.deltaY;
  }, []);


  /** カテゴリボタン1個（スクロール領域と右端固定の両方で使う）。 */
  const renderCategoryButton = (cat: string) => (
    <button
      key={cat}
      type="button"
      // 260623: マウスオーバーで自動的にパネルを立ち上げる（クリック不要で一覧を出す）。260703(5): 初回は少し遅延して開く。
      onClick={(e) => clickToggle(cat, e.currentTarget)}
      onMouseEnter={(e) => hoverOpen(cat, e.currentTarget)}
      // ボタンから隙間へ抜けたら保留中のオープンを取消（閉じている時のみ）。開いている時の自動クローズはコンテナ側 onMouseLeave が担当。
      onMouseLeave={() => { if (!selectedAssetCategory) clearOpenTimer(); }}
      aria-pressed={highlightedCategory === cat}
      // 選択中は塗り・枠・文字をまとめて変える（260729 要望④）。以前は選択色が
      // bg-emerald-500/20 と控えめで、しかもパネルを閉じると消えていたため見分けが付かなかった。
      className={`h-full w-auto min-w-[60px] shrink-0 px-2.5 rounded-xl border transition-all flex flex-col items-center justify-center gap-1 group ${
        highlightedCategory === cat
          ? 'bg-emerald-500 border-emerald-300 text-white font-black shadow-[0_0_0_2px_rgba(16,185,129,0.35)]'
          : cat === UPLOAD_CATEGORY
            ? 'bg-emerald-600/90 border-emerald-500 text-white hover:bg-emerald-500'
            : 'bg-neutral-800/80 border-white/10 text-white hover:border-white/30'
      }`}
    >
      {/* 長いカテゴリ名（例: カウンターチェア）が折り返して溢れないよう、幅は内容に合わせラベルは折り返さない（260727）。 */}
      <span className="whitespace-nowrap text-[10px] font-black uppercase tracking-wide">{cat}</span>
    </button>
  );

  if (fetchStatus === 'loading') {
    return (
      <div className={`relative flex items-center gap-3 pointer-events-auto ${className}`}>
        <div className={`${barClass} px-4 justify-center min-w-[200px]`}>
          <span className="text-[10px] font-bold text-neutral-400 tracking-wide">家具カタログを読み込み中…</span>
        </div>
      </div>
    );
  }

  if (fetchStatus === 'error') {
    return (
      <div className={`relative flex items-center gap-3 pointer-events-auto ${className}`}>
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
      <div className={`relative flex items-center gap-3 pointer-events-auto ${className}`}>
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
      ref={containerRef}
      className={`relative flex items-center gap-3 pointer-events-auto ${className}`}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      {selectedAssetCategory && (
        <div
          className="absolute bottom-[calc(100%+16px)] glass p-4 rounded-3xl border border-white/10 bg-black/80 backdrop-blur-2xl shadow-2xl animate-in fade-in slide-in-from-bottom-2"
          // ホバーしたボタンの真上に中央寄せで表示（アンカー未測定時は従来どおり右寄せにフォールバック）。
          // 中央寄せは transform ではなく marginLeft で行う（入場アニメの slide-in が transform を使うため競合回避）。
          style={
            anchorPos
              ? { left: anchorPos.left, width: popupWidthCss, marginLeft: -anchorPos.width / 2 }
              : { right: 0, width: popupWidthCss }
          }
        >
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
          {/* サムネイルの大きさをその場で変える（260729 クライアント要望②）。
              右レールの建材カタログと同じ操作感に揃える（左=小さく多列 / 右=大きく少列）。 */}
          <div className="mb-2 flex items-center gap-2 px-1">
            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden />
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={thumbSize}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v)) setThumbSize(Math.min(4, Math.max(1, v)));
              }}
              className="catalog-thumb-size-slider h-1 w-[88px] shrink-0 cursor-pointer accent-emerald-500"
              aria-label="サムネイルの大きさ（左が小さく、右が大きい）"
              title="サムネイルの大きさ（左: 小さく多く / 右: 大きく少なく）"
            />
            <LayoutList className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden />
          </div>
          {/* 2行ぶんだけ見せて以降はスクロール。scrollbarGutter:'stable' でスクロールバー出現時にセル幅が
              揺れる（＝行数が変わって見える）のを防ぐ。列数はサイズスライダーで変わるので
              Tailwind の grid-cols-N ではなくインライン指定にする（動的クラスは purge で消える）。 */}
          <div
            data-testid="asset-grid"
            className="grid gap-2 overflow-y-auto pr-1 scroll-dark"
            style={{
              gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
              maxHeight: gridMaxHeight,
              scrollbarGutter: 'stable',
            }}
          >
            {selectedAssetCategory === UPLOAD_CATEGORY && onUploadModel && (
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
            {visibleItems
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onPickItem(item);
                    onSelectedAssetCategoryChange(null);
                  }}
                  // サムネイル背景はアイボリー（260729 クライアント要望⑤・色は index.css の --thumb-bg）。
                  // 中の ModelThumbnail が全面を覆うので、ここの色はホバー時と読み込み前に見える。
                  className="aspect-square rounded-2xl bg-[var(--thumb-bg)] border border-white/10 text-white hover:border-emerald-500 hover:bg-[var(--thumb-bg-hover)] transition-all overflow-hidden relative group"
                  title={item.name}
                >
                  <div className="absolute inset-0 opacity-80 group-hover:opacity-100 group-hover:scale-110 transition-all duration-500">
                    {/* 取り込み向き（上下 modelUprightXDeg・前後 forwardYawDeg）をサムネイル生成へ渡す（260725・クライアント要望③）。
                        従来は url/name だけを渡しており、向きが反映されず倒れ/背面のままだった。 */}
                    {renderThumbnail({
                      url: item.url,
                      name: item.name,
                      modelUprightXDeg: item.modelUprightXDeg,
                      forwardYawDeg: item.forwardYawDeg,
                      thumbnailUrl: item.thumbnailUrl,
                    })}
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/10 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-2xl font-black text-emerald-400 drop-shadow-md">+</span>
                  </div>
                </button>
              ))}
          </div>
        </div>
      )}

      {/* カテゴリは横1行。6個目以降は横スクロール、「アップロード」は右端に固定（260728 クライアント要望）。 */}
      <div className={barClass}>
        {/* 左矢印（はみ出している時だけ） */}
        {scrollState.overflowing && (
          <button
            type="button"
            onClick={() => scrollByStep(-1)}
            disabled={scrollState.atStart}
            aria-label="カテゴリを左へスクロール"
            title="左へ"
            className="flex h-full w-5 shrink-0 items-center justify-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-25"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        {/* スクロール領域＋位置インジケータ。インジケータは絶対配置なのでボタンの高さを変えない。 */}
        <div className="relative h-full" style={scrollerMaxWidth != null ? { maxWidth: scrollerMaxWidth } : undefined}>
          <div
            ref={scrollerRef}
            onScroll={updateScrollState}
            onWheel={handleScrollerWheel}
            className={`flex h-full items-center gap-1.5 overflow-x-auto overflow-y-hidden scrollbar-none overscroll-x-contain ${
              scrollState.overflowing ? 'pb-1.5' : ''
            }`}
          >
            {scrollableCategories.map(renderCategoryButton)}
          </div>
          {/* 位置インジケータ（見えている範囲と現在位置）。スクロールバーの代わり。 */}
          {scrollState.overflowing && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 rounded-full bg-white/10" aria-hidden>
              <div
                className="h-full rounded-full bg-white/60 transition-[margin] duration-100"
                style={{ width: `${scrollState.thumbPct}%`, marginLeft: `${scrollState.thumbLeftPct}%` }}
              />
            </div>
          )}
        </div>

        {/* 右矢印（はみ出している時だけ） */}
        {scrollState.overflowing && (
          <button
            type="button"
            onClick={() => scrollByStep(1)}
            disabled={scrollState.atEnd}
            aria-label="カテゴリを右へスクロール"
            title="右へ"
            className="flex h-full w-5 shrink-0 items-center justify-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-25"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        {uploadCategory && (
          // スクロール領域の外に置くことで、いくつカテゴリが増えても常に右端に見える。
          <div className="flex h-full shrink-0 items-center gap-1.5">
            {scrollState.overflowing && <div className="h-8 w-px shrink-0 bg-white/15" aria-hidden />}
            {renderCategoryButton(uploadCategory)}
          </div>
        )}
      </div>
    </div>
  );
};
