import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 右サイドパネル下部の「使用中」一覧（260730 クライアント要望②）。
 *
 * 3Dビューに今なにが適用・配置されているかを、カタログを閉じずに一目で確認するための枠。
 * 建材タブなら「使用中の建材」、3Dモデルタブなら「使用中の3Dモデル」を出す。
 *
 * 上端をドラッグして高さを変えられる。カタログ側と場所を取り合うので、
 * どちらを広く見たいかは作業内容で変わる＝利用者が決められる必要がある。
 * 変えた高さは端末に保存する（毎回やり直させない）。
 */

/** 高さの下限・上限（px）。下限は見出し＋1行が見える程度、上限はレールを埋め尽くさない程度。 */
const MIN_H = 96;
const MAX_H = 520;
const DEFAULT_H = 168;

function loadHeight(storageKey: string): number {
  try {
    const v = parseInt(localStorage.getItem(storageKey) ?? '', 10);
    return Number.isFinite(v) ? Math.min(MAX_H, Math.max(MIN_H, v)) : DEFAULT_H;
  } catch {
    return DEFAULT_H;
  }
}

export interface InUseEntry {
  /** 一覧内で一意なキー。 */
  key: string;
  /** ホバー時に出す名前。 */
  label: string;
  /** サムネイルの中身。建材は <img>、3Dモデルは ModelThumbnail を渡す。 */
  thumbnail: React.ReactNode;
  /** 補助表示（メーカー名など・省略可）。 */
  sub?: string;
}

export function InUsePanel({
  title,
  entries,
  columns,
  storageKey,
  emptyMessage,
}: {
  title: string;
  entries: InUseEntry[];
  /** カタログ側と同じ列数（サムネイルの大きさを揃える・クライアント要望）。 */
  columns: number;
  storageKey: string;
  emptyMessage: string;
}) {
  const [height, setHeight] = useState<number>(() => loadHeight(storageKey));
  // ドラッグ開始時の値。ポインタ移動量は「上へ動かすほど高くなる」ので符号を反転して足す。
  const dragRef = useRef<null | { startY: number; startH: number }>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(height));
    } catch {
      /* 保存不可（プライベートモード等）でも動作は続ける */
    }
  }, [height, storageKey]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // 上端を掴んでいるので、上（Y が小さい方）へ動かすと高くなる。
      const next = d.startH + (d.startY - e.clientY);
      setHeight(Math.min(MAX_H, Math.max(MIN_H, next)));
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startDrag = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startY: e.clientY, startH: height };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }, [height]);

  return (
    <div
      className="shrink-0 border-t border-white/10 bg-[#080808]"
      style={{ height }}
      data-testid="in-use-panel"
    >
      {/* 上端の掴み手。細い帯なので、掴めることが分かるよう中央に線を出す。 */}
      <div
        role="separator"
        aria-label={`${title}の高さを変更`}
        onMouseDown={startDrag}
        data-testid="in-use-resize"
        className="group flex h-3 w-full cursor-ns-resize items-center justify-center"
      >
        <div className="h-0.5 w-10 rounded-full bg-white/20 transition-colors group-hover:bg-emerald-400/70" />
      </div>
      <div className="flex h-[calc(100%-0.75rem)] flex-col px-6 pb-3 md:px-8">
        <div className="mb-1.5 flex shrink-0 items-center justify-between">
          <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400">{title}</span>
          <span className="font-mono text-[10px] text-neutral-500">{entries.length}</span>
        </div>
        {entries.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-white/10 text-center text-[10px] font-bold text-neutral-600">
            {emptyMessage}
          </div>
        ) : (
          // 収まらない分はこの中でスクロールする（パネル自体は伸びない）。
          <div
            data-testid="in-use-grid"
            className="scroll-dark grid min-h-0 flex-1 gap-2 overflow-y-auto pr-1"
            style={{
              gridTemplateColumns: columns === 1 ? '1fr' : `repeat(${columns}, minmax(0, 1fr))`,
              gridAutoRows: 'min-content',
            }}
          >
            {entries.map((e) => (
              <div
                key={e.key}
                title={e.sub ? `${e.label}（${e.sub}）` : e.label}
                className="relative aspect-square overflow-hidden rounded-xl border border-white/10 bg-[var(--thumb-bg)]"
              >
                {e.thumbnail}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
