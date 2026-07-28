import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Move, Minus, Plus, RotateCcw } from 'lucide-react';

// ドラッグで移動・±で拡大縮小できるフローティングパネル（260703 クライアント要望）。
// 3Dビューの操作パネル（視点操作／オブジェクト情報／マテリアル）が家具ギズモや他パネルに被る問題を、
// ユーザーが任意位置・任意サイズへ動かして回避できるようにする。位置・倍率は localStorage（ブラウザ単位）へ保存。
// 260703(2): 移動範囲を getBounds（3Dプレビュー領域）内に制限し、操作したパネルを最前面(onFocus/zIndex)にして
//   「他パネルの下・画面外に潜って取り出せなくなる」のを防ぐ（＝重なりは許容しつつ常に取り出せる方式）。

const MIN_SCALE = 0.6;
const MAX_SCALE = 1.6;
const SCALE_STEP = 0.1;

export type PanelAnchor = 'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-right' | 'top-left';
export interface PanelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** リサイズ下限（px・レイアウト座標＝倍率をかける前）。これ以下だと中身が潰れて操作できなくなる。 */
const DEFAULT_MIN_W = 220;
const DEFAULT_MIN_H = 96;

/** 掴める枠の太さ（px）。細すぎると掴めず、太すぎると中身のクリックを奪う。 */
const HANDLE = 8;

/** リサイズの向き。n/s/e/w の組み合わせ。 */
type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Persisted {
  x: number;
  y: number;
  scale: number;
  /** 明示サイズ（260729 クライアント要望①）。未保存＝中身なりの自動サイズ。 */
  w?: number;
  h?: number;
}

function loadPersisted(key: string): Persisted | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Persisted>;
    if (typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.scale === 'number') {
      // w/h は後から追加した項目。古い保存データ（x/y/scale のみ）でも位置を失わないよう任意扱いにする。
      const w = typeof p.w === 'number' && p.w > 0 ? p.w : undefined;
      const h = typeof p.h === 'number' && p.h > 0 ? p.h : undefined;
      return { x: p.x, y: p.y, scale: p.scale, w, h };
    }
  } catch {
    /* パース失敗は既定へ */
  }
  return null;
}

const viewportBounds = (): PanelBounds => ({
  left: 0,
  top: 0,
  right: typeof window !== 'undefined' ? window.innerWidth : 1200,
  bottom: typeof window !== 'undefined' ? window.innerHeight : 800,
});

export function MovablePanel({
  storageKey,
  label = '操作パネル',
  anchor = 'bottom-center',
  getBounds,
  zIndex,
  onFocus,
  onRect,
  minWidth = DEFAULT_MIN_W,
  minHeight = DEFAULT_MIN_H,
  resizable = true,
  defaultWidth,
  defaultHeight,
  children,
}: {
  storageKey: string;
  label?: string;
  /** 保存位置が無いときの既定コーナー（現行レイアウトに合わせる）。 */
  anchor?: PanelAnchor;
  /** ドラッグ可能領域（3Dプレビュー領域）。省略時はビューポート全体。 */
  getBounds?: () => PanelBounds;
  /** 最前面制御用の z-index（App が操作順で採番）。 */
  zIndex?: number;
  /** パネル上で mousedown したら最前面へ（App が採番を更新）。 */
  onFocus?: () => void;
  /** パネルの画面上の矩形（倍率込み・top/bottom/left/right）を通知。重なり回避（位置依存）に使う。消滅時は null。 */
  onRect?: (rect: { top: number; bottom: number; left: number; right: number } | null) => void;
  /** リサイズ下限（レイアウトpx）。中身が潰れない値をパネルごとに渡す。 */
  minWidth?: number;
  minHeight?: number;
  /** 枠ドラッグでのリサイズを許可するか（既定 true・260729 クライアント要望①）。 */
  resizable?: boolean;
  /** 未リサイズ時の既定サイズ（CSS長さ）。省略時は中身なり。中身側は w-full/h-full で追従させる。 */
  defaultWidth?: number | string;
  defaultHeight?: number | string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const persisted = useRef<Persisted | null>(loadPersisted(storageKey));
  const [pos, setPos] = useState<{ x: number; y: number } | null>(
    persisted.current ? { x: persisted.current.x, y: persisted.current.y } : null,
  );
  const [scale, setScale] = useState<number>(persisted.current?.scale ?? 1);
  /**
   * 明示サイズ（260729 クライアント要望①）。null＝中身なりの自動サイズ（従来動作）。
   * 倍率(scale)とは別物であることに注意: scale は見た目を一律に拡大するだけで折り返しは変わらないが、
   * こちらは実際のレイアウト幅・高さなので中身が再配置される（例: カタログの列数が増える）。
   */
  const [size, setSize] = useState<{ w: number; h: number } | null>(
    persisted.current?.w && persisted.current?.h ? { w: persisted.current.w, h: persisted.current.h } : null,
  );
  const dragRef = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null);
  const resizeRef = useRef<null | {
    dir: ResizeDir;
    sx: number;
    sy: number;
    w0: number;
    h0: number;
    x0: number;
    y0: number;
  }>(null);

  const boundsOf = useCallback((): PanelBounds => getBounds?.() ?? viewportBounds(), [getBounds]);

  // アンカーに応じた既定位置（実測サイズ r・領域 b から算出）。
  const anchoredPos = useCallback(
    (w: number, h: number) => {
      const b = boundsOf();
      const m = 8;
      const cx = Math.max(b.left + m, (b.left + b.right - w) / 2);
      const rightX = Math.max(b.left + m, b.right - w - m);
      const bottomY = Math.max(b.top + m, b.bottom - h - m);
      switch (anchor) {
        case 'top-right':
          return { x: rightX, y: b.top + m };
        case 'top-left':
          return { x: b.left + m, y: b.top + m };
        case 'bottom-right':
          return { x: rightX, y: bottomY };
        case 'bottom-left':
          return { x: b.left + m, y: bottomY };
        default:
          return { x: cx, y: bottomY };
      }
    },
    [anchor, boundsOf],
  );

  // 保存位置が無い場合は初回レンダ後に実測してアンカー位置へ。
  useLayoutEffect(() => {
    if (pos) return;
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(anchoredPos(r.width, r.height));
  }, [pos, anchoredPos]);

  // パネルが領域内に収まるようクランプ（左上コーナー基準）。パネルが領域より大きい場合は左上を b.left/b.top へ寄せる。
  const clampPos = useCallback(
    (x: number, y: number) => {
      const el = rootRef.current;
      const w = el ? el.getBoundingClientRect().width : 320;
      const h = el ? el.getBoundingClientRect().height : 120;
      const b = boundsOf();
      const maxX = Math.max(b.left, b.right - w);
      const maxY = Math.max(b.top, b.bottom - h);
      return { x: Math.min(maxX, Math.max(b.left, x)), y: Math.min(maxY, Math.max(b.top, y)) };
    },
    [boundsOf],
  );

  // 領域が変わった（ヘッダ実測で top 確定・ウィンドウリサイズ・保存位置が領域外）ら現在位置を領域内へ引き戻す。
  // clampPos は getBounds 依存のため headerHeight が 0→実測に変わると再実行され、初回のヘッダ下潜り/画面外も解消する
  // （260703(2) 検証 A/B/C）。位置が変わらないときは同一参照を返して再レンダを避ける。
  useLayoutEffect(() => {
    const reclamp = () => {
      // 保存サイズが今の領域より大きい場合は縮める（画面の小さい端末で開いたとき等・敵対レビュー #4）。
      setSize((s) => {
        if (!s) return s;
        const b = boundsOf();
        const w = Math.min(s.w, Math.max(minWidth, (b.right - b.left) / scale));
        const h = Math.min(s.h, Math.max(minHeight, (b.bottom - b.top) / scale));
        return w === s.w && h === s.h ? s : { w, h };
      });
      setPos((p) => {
        if (!p) return p;
        const c = clampPos(p.x, p.y);
        return c.x === p.x && c.y === p.y ? p : c;
      });
    };
    reclamp();
    // 中身の実測サイズが後から変わる場合にも引き戻す（敵対レビュー #5）。
    // 例: カタログは読込中だけ幅が狭く、右下アンカーで位置を決めた後に本来の幅へ伸びる。
    // これを拾わないと、伸びたぶんが領域の外へはみ出したまま保存される。
    const el = rootRef.current;
    const ro = el ? new ResizeObserver(reclamp) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener('resize', reclamp);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', reclamp);
    };
  }, [clampPos, boundsOf, scale, minWidth, minHeight]);

  // 永続化。
  useEffect(() => {
    if (!pos) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ x: pos.x, y: pos.y, scale, w: size?.w, h: size?.h }),
      );
    } catch {
      /* quota/private mode */
    }
  }, [pos, scale, size, storageKey]);

  // 矩形通知（倍率込みの top/bottom）。位置に応じた重なり回避に使う。ObserverはonRect安定時に1回だけ購読し、
  // 消滅時のみ null で通知（ドラッグ中の pos 変化で毎フレーム null→rect と点滅しないよう分離・260703(2) 検証F）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onRect) return;
    const notify = () => {
      const r = el.getBoundingClientRect();
      onRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    };
    notify();
    const ro = new ResizeObserver(notify);
    ro.observe(el);
    return () => {
      ro.disconnect();
      onRect(null);
    };
  }, [onRect]);
  // pos/scale 変化時は矩形を再通知（null にはしない）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onRect) return;
    const r = el.getBoundingClientRect();
    onRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  }, [onRect, pos, scale, size]);

  // ドラッグ（window で move/up を拾い、パネル外でも追従）。移動とリサイズの両方をここで扱う。
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (r) {
        // 【重要】ポインタの移動量は「画面px」だが、パネルは transform: scale で拡大されている。
        // レイアウト上の幅・高さへ反映するには倍率で割る必要がある（割らないと 160% 表示時に
        // 掴んだ枠がカーソルの1.6倍動いて、まったく追従しない）。
        // 一方 left/top は自分自身の transform の影響を受けない画面座標なので、こちらは割らない。
        const dx = (e.clientX - r.sx) / scale;
        const dy = (e.clientY - r.sy) / scale;
        const b = boundsOf();
        const horiz = r.dir.includes('e') || r.dir.includes('w');
        const vert = r.dir.includes('n') || r.dir.includes('s');

        // 掴んでいない軸には一切触らない。両軸を毎回クランプすると、辺（1軸）を掴んだだけで
        // もう一方が下限へスナップして勝手に形が変わる（敵対レビュー #9）。
        let w = r.w0;
        let h = r.h0;
        let x = r.x0;
        let y = r.y0;

        if (horiz) {
          // 上限は「掴んでいない側の辺」を固定したまま領域内に収まる最大値。
          // 西を掴むときは左上が動くので、左上が b.left より外へ出ない値が上限になる
          // （＝これを守らないとパネルが領域外へ歩いていく・敵対レビュー #1/#12）。
          const maxW = Math.max(minWidth, r.dir.includes('w') ? r.w0 + (r.x0 - b.left) / scale : (b.right - r.x0) / scale);
          w = Math.min(maxW, Math.max(minWidth, r.dir.includes('w') ? r.w0 - dx : r.w0 + dx));
          // 縮んだぶんだけ左上を動かして反対側の辺を固定して見せる。
          // 実際に縮んだ量（クランプ後）を使うこと。素の dx を足すと下限に当たった後もパネルが滑る。
          if (r.dir.includes('w')) x = r.x0 + (r.w0 - w) * scale;
        }
        if (vert) {
          // 北を掴むときの上限は「ルート上端（＝掴むためのグリップ）が b.top より上へ行かない」こと。
          // ここを守らないと、グリップ（移動・倍率・初期化）が画面外へ出て
          // パネルを二度と動かせず初期化もできなくなり、その位置が保存までされる（敵対レビュー #1）。
          const maxH = Math.max(minHeight, r.dir.includes('n') ? r.h0 + (r.y0 - b.top) / scale : (b.bottom - r.y0) / scale);
          h = Math.min(maxH, Math.max(minHeight, r.dir.includes('n') ? r.h0 - dy : r.h0 + dy));
          if (r.dir.includes('n')) y = r.y0 + (r.h0 - h) * scale;
        }

        setSize({ w, h });
        setPos({ x, y });
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      setPos(clampPos(d.ox + (e.clientX - d.sx), d.oy + (e.clientY - d.sy)));
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [clampPos, scale, boundsOf, minWidth, minHeight]);

  /** 枠を掴んだ瞬間。まだ明示サイズが無ければ、その時点の実測サイズを起点にする。 */
  const startResize = useCallback(
    (dir: ResizeDir) => (e: React.MouseEvent) => {
      if (!pos) return;
      const el = contentRef.current;
      const r = el?.getBoundingClientRect();
      // getBoundingClientRect は倍率込みの画面サイズなので、レイアウト座標へ戻してから起点にする。
      const w0 = size?.w ?? (r ? r.width / scale : minWidth);
      const h0 = size?.h ?? (r ? r.height / scale : minHeight);
      resizeRef.current = { dir, sx: e.clientX, sy: e.clientY, w0, h0, x0: pos.x, y0: pos.y };
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation(); // グリップの移動ドラッグと二重に走らせない
    },
    [pos, size, scale, minWidth, minHeight],
  );

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (!pos) return;
      dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
      document.body.style.userSelect = 'none';
      e.preventDefault();
    },
    [pos],
  );

  const changeScale = (d: number) =>
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((s + d) * 10) / 10)));

  const resetPanel = () => {
    // サイズ・倍率を既定へ戻し、位置は null にして「初回マウントと同じ再測定」に任せる。
    // 明示サイズを解除した後の自然サイズは解除後にしか測れないため、ここで実測しても意味がない。
    setScale(1);
    setSize(null);
    setPos(null);
  };

  return (
    <div
      ref={rootRef}
      // onMouseDownCapture: 子の stopPropagation に関係なく最前面化（採番を更新）。
      onMouseDownCapture={() => onFocus?.()}
      className="fixed pointer-events-auto"
      style={{
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        zIndex: zIndex ?? 40,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {/* グリップ（ドラッグで移動）＋拡大縮小＋初期化。 */}
      <div
        onMouseDown={startDrag}
        className="mb-1 flex w-full cursor-move select-none items-center gap-1 rounded-xl border border-white/10 bg-black/55 px-2 py-1 shadow-lg backdrop-blur-md"
      >
        <Move className="h-3 w-3 text-neutral-400" />
        <span className="text-[9px] font-black uppercase tracking-wider text-neutral-400">{label}</span>
        <div className="ml-auto flex items-center gap-0.5" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            title="縮小"
            aria-label="縮小"
            onClick={() => changeScale(-SCALE_STEP)}
            className="rounded p-0.5 text-neutral-300 transition hover:bg-white/10"
          >
            <Minus className="h-3 w-3" />
          </button>
          <span className="w-7 text-center text-[9px] font-mono text-neutral-400">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            title="拡大"
            aria-label="拡大"
            onClick={() => changeScale(SCALE_STEP)}
            className="rounded p-0.5 text-neutral-300 transition hover:bg-white/10"
          >
            <Plus className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="位置とサイズを初期化"
            aria-label="位置とサイズを初期化"
            onClick={resetPanel}
            className="ml-0.5 rounded p-0.5 text-neutral-300 transition hover:bg-white/10"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      </div>
      {/*
        中身のラッパ。明示サイズはここに当てる（ヘッダは常に一定の高さで、伸縮の対象ではない）。
        ルートは shrink-to-fit なので、ここに幅が付くとルートとヘッダ(w-full)もその幅に揃う。
        リサイズ中に中身の iframe/canvas がポインタを奪わないよう、掴んでいる間だけ pointer-events を切る。
      */}
      <div
        ref={contentRef}
        // data-panel-sized: 中身側で「明示サイズが入っているか」をCSSから知るための印。
        // 中身が持つ max-h-[75vh] 等の高さ上限は、ユーザーが枠を広げたときには邪魔になる
        // （枠だけ伸びて中身が伸びない＝ハンドルが見た目の縁から離れる・敵対レビュー #2）。
        // index.css 側で .panel-fill の上限を解除する。
        data-panel-sized={size ? 'true' : 'false'}
        // リサイズ後は「今どこまでがパネルか」が見えるよう、薄い面を敷く。
        // 透明なまま広げると、中身の無い領域が見えない当たり判定になって
        // 3Dビューのクリック（選択解除）を黙って食う（同 #2）。
        className={`relative ${size ? 'rounded-xl border border-white/10 bg-black/25' : ''}`}
        // 未リサイズ時は defaultWidth/defaultHeight（＝従来の見た目）。省略すれば中身なりの自動サイズ。
        // 一度リサイズしたら、そのユーザー指定が既定より優先される。
        style={{ width: size?.w ?? defaultWidth, height: size?.h ?? defaultHeight }}
      >
        {children}
        {resizable && pos && (
          <>
            {/*
              枠（端・角）のリサイズハンドル（260729 クライアント要望①）。
              辺は「はみ出さない」よう内側に敷き、角は辺より前面に置いて斜めリサイズを優先させる。
              中身のスクロールバーと喧嘩しないよう、辺の当たりは HANDLE px と細くしている。
            */}
            {/*
              ハンドルは中身の箱の「外側」に置く（敵対レビュー #3/#11）。
              半分でも内側に食い込ませると、スクロールする中身（scroll-dark の幅8pxのスクロールバー）に
              重なり、スクロールバーを掴んだつもりがリサイズになる。
            */}
            {(
              [
                ['n', 'cursor-ns-resize', { top: -HANDLE, left: 0, right: 0, height: HANDLE }],
                ['s', 'cursor-ns-resize', { bottom: -HANDLE, left: 0, right: 0, height: HANDLE }],
                ['w', 'cursor-ew-resize', { left: -HANDLE, top: 0, bottom: 0, width: HANDLE }],
                ['e', 'cursor-ew-resize', { right: -HANDLE, top: 0, bottom: 0, width: HANDLE }],
                ['nw', 'cursor-nwse-resize', { top: -HANDLE, left: -HANDLE, width: HANDLE * 2, height: HANDLE * 2 }],
                ['ne', 'cursor-nesw-resize', { top: -HANDLE, right: -HANDLE, width: HANDLE * 2, height: HANDLE * 2 }],
                ['sw', 'cursor-nesw-resize', { bottom: -HANDLE, left: -HANDLE, width: HANDLE * 2, height: HANDLE * 2 }],
                ['se', 'cursor-nwse-resize', { bottom: -HANDLE, right: -HANDLE, width: HANDLE * 2, height: HANDLE * 2 }],
              ] as Array<[ResizeDir, string, React.CSSProperties]>
            ).map(([dir, cursor, style]) => (
              <div
                key={dir}
                role="presentation"
                aria-hidden
                data-resize-dir={dir}
                onMouseDown={startResize(dir)}
                className={`absolute ${cursor} ${dir.length === 2 ? 'z-20' : 'z-10'}`}
                style={style}
              />
            ))}
            {/* 右下だけは掴める場所が見て分かるよう、控えめな目印を出す。 */}
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-0.5 right-0.5 z-20 h-2 w-2 rounded-sm border-b-2 border-r-2 border-white/25"
            />
          </>
        )}
      </div>
    </div>
  );
}
