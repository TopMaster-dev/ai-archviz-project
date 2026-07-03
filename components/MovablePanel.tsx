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

interface Persisted {
  x: number;
  y: number;
  scale: number;
}

function loadPersisted(key: string): Persisted | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Persisted>;
    if (typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.scale === 'number') {
      return { x: p.x, y: p.y, scale: p.scale };
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
  /** パネルの画面上の矩形（倍率込みの top/bottom）を通知。重なり回避（位置依存）に使う。消滅時は null。 */
  onRect?: (rect: { top: number; bottom: number } | null) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const persisted = useRef<Persisted | null>(loadPersisted(storageKey));
  const [pos, setPos] = useState<{ x: number; y: number } | null>(
    persisted.current ? { x: persisted.current.x, y: persisted.current.y } : null,
  );
  const [scale, setScale] = useState<number>(persisted.current?.scale ?? 1);
  const dragRef = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null);

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
    const reclamp = () =>
      setPos((p) => {
        if (!p) return p;
        const c = clampPos(p.x, p.y);
        return c.x === p.x && c.y === p.y ? p : c;
      });
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [clampPos]);

  // 永続化。
  useEffect(() => {
    if (!pos) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ x: pos.x, y: pos.y, scale }));
    } catch {
      /* quota/private mode */
    }
  }, [pos, scale, storageKey]);

  // 矩形通知（倍率込みの top/bottom）。位置に応じた重なり回避に使う。ObserverはonRect安定時に1回だけ購読し、
  // 消滅時のみ null で通知（ドラッグ中の pos 変化で毎フレーム null→rect と点滅しないよう分離・260703(2) 検証F）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onRect) return;
    const notify = () => {
      const r = el.getBoundingClientRect();
      onRect({ top: r.top, bottom: r.bottom });
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
    onRect({ top: r.top, bottom: r.bottom });
  }, [onRect, pos, scale]);

  // ドラッグ（window で move/up を拾い、パネル外でも追従）。
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos(clampPos(d.ox + (e.clientX - d.sx), d.oy + (e.clientY - d.sy)));
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
  }, [clampPos]);

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
    const el = rootRef.current;
    const r = el?.getBoundingClientRect();
    // 実寸→倍率1相当のサイズへ換算してアンカー位置へ戻す。
    const w = r ? r.width / scale : 400;
    const h = r ? r.height / scale : 120;
    setScale(1);
    setPos(anchoredPos(w, h));
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
        className="mb-1 flex cursor-move select-none items-center gap-1 rounded-xl border border-white/10 bg-black/55 px-2 py-1 shadow-lg backdrop-blur-md"
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
      {children}
    </div>
  );
}
