import type { Product } from '../types.js';

/**
 * 建材1件の表示（260730 クライアント要望①②）。
 *
 * カタログと「使用中の建材」で必ず同じ見た目にするため、描画はこの1か所だけに置く。
 * 以前はカタログ側にインラインで書かれており、使用中パネルは別の見た目（正方形サムネのみ）だった。
 * 2か所に同じマークアップを置くと、片方だけ直されて必ずずれる。
 *
 * 列数が1のときはリスト行（サムネ＋メーカー＋名称＋単価）、2列以上はタイル（画像の上に情報を重ねる）。
 * この切り替えもカタログと共通なので、スライダーを動かすと両方が同時に切り替わる。
 */
export function MaterialCard({
  product,
  columns,
  selected,
  disabled,
  onSelect,
  thumbnailUrl,
}: {
  product: Product;
  /** カタログと同じ列数。1＝リスト表示。 */
  columns: number;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  /** 一覧用に軽量化したサムネイルURL（App の getThumbnailUrl を通したもの）。 */
  thumbnailUrl: string;
}) {
  const price = `¥${product.pricePerUnit.toLocaleString()}`;

  if (columns === 1) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        title={product.name}
        // min-w-0 が無いと、グリッドの子は既定の min-width:auto ＝「中身の最小幅」で場所を取り、
        // 品番のような改行できない長い名前で親からはみ出す（＝横スクロールが出る）。
        className={`flex min-w-0 items-center gap-3 rounded-xl border p-2 text-left transition-all ${
          selected ? 'border-emerald-500 bg-emerald-500/5' : 'border-white/5 bg-[#111] hover:border-white/20'
        } ${disabled ? 'opacity-50 grayscale' : ''}`}
      >
        <img src={thumbnailUrl} className="h-12 w-12 shrink-0 rounded-lg bg-neutral-900 object-cover" alt="" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[8px] font-black uppercase tracking-wider text-emerald-400">{product.brand}</div>
          <div className="truncate text-[11px] font-bold text-white">{product.name}</div>
        </div>
        <div className="shrink-0 px-2 text-right font-mono text-xs text-neutral-300">{price}</div>
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      title={product.name}
      className={`group relative aspect-square min-w-0 overflow-hidden rounded-2xl border transition-all duration-300 md:aspect-[4/5] ${
        selected ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.2)]' : 'border-white/5 hover:border-white/30'
      } ${disabled ? 'opacity-50 grayscale' : ''}`}
    >
      <div className="absolute inset-0 bg-neutral-900">
        <img
          src={thumbnailUrl}
          className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-110"
          alt={product.name}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80" />
      </div>
      <div className="absolute inset-0 flex flex-col justify-end p-3 text-left">
        <div className="mb-1 text-[8px] font-black uppercase tracking-wider text-emerald-400">{product.brand}</div>
        <h3 className="mb-1.5 line-clamp-2 text-[10px] font-bold leading-tight text-white">{product.name}</h3>
        <span className="font-mono text-xs text-neutral-300">{price}</span>
      </div>
    </button>
  );
}
