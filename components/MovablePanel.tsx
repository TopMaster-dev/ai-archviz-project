import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Move, Minus, Plus, RotateCcw } from 'lucide-react';

// ドラッグで移動・±で拡大縮小できるフローティングパネル（260703 クライアント要望）。
// 3Dビューの視点操作パネルが家具の回転/移動ギズモに被って選択できない問題を、
// ユーザーが任意の位置・任意のサイズへ動かして回避できるようにする。
// 位置・倍率は localStorage（ブラウザ単位のUI設定）に保存。既定は下部中央（従来位置）。
// 実装は OnboardingGuide のドラッグ/リサイズ方式を踏襲（背景オーバーレイ無し＝裏の3Dを操作可）。

const MIN_SCALE = 0.6;
const MAX_SCALE = 1.6;
const SCALE_STEP = 0.1;

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

export function MovablePanel({
  storageKey,
  label = '操作パネル',
  onRect,
  children,
}: {
  storageKey: string;
  label?: string;
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

  // 保存位置が無い場合は初回レンダ後に実測して下部中央へ（従来位置と同じに見える）。
  useLayoutEffect(() => {
    if (pos) return;
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, (window.innerWidth - r.width) / 2),
      y: Math.max(8, window.innerHeight - r.height - 24),
    });
  }, [pos]);

  // 保存位置が（前回より小さいウィンドウで）画面外になっていたら初回に引き戻す。
  const didMountClamp = useRef(false);
  useLayoutEffect(() => {
    if (didMountClamp.current || !pos) return;
    didMountClamp.current = true;
    const c = clampPos(pos.x, pos.y);
    if (c.x !== pos.x || c.y !== pos.y) setPos(c);
    // clampPos/pos は初回のみ参照（マウント時1回だけ）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  // グリップ（左上）が必ず掴める範囲へクランプ。left/top は未スケール座標なので幅は使わず、
  // 左上コーナー自体を画面内（左8px〜右端-80px、上0〜下端-40px）に収める（拡大時もグリップ到達可・260703 検証A）。
  const clampPos = useCallback(
    (x: number, y: number) => ({
      x: Math.min(window.innerWidth - 80, Math.max(8, x)),
      y: Math.min(window.innerHeight - 40, Math.max(0, y)),
    }),
    [],
  );

  // 永続化。
  useEffect(() => {
    if (!pos) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ x: pos.x, y: pos.y, scale }));
    } catch {
      /* quota/private mode */
    }
  }, [pos, scale, storageKey]);

  // 矩形通知（倍率込みの top/bottom）。位置に応じた重なり回避に使う。消滅時は null で通知。
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
  }, [onRect, scale, pos]);

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
    // 実寸→倍率1相当のサイズへ換算して下部中央へ。
    const w = r ? r.width / scale : 400;
    const h = r ? r.height / scale : 120;
    setScale(1);
    setPos({
      x: Math.max(8, (window.innerWidth - w) / 2),
      y: Math.max(8, window.innerHeight - h - 24),
    });
  };

  return (
    <div
      ref={rootRef}
      className="fixed z-40 pointer-events-auto"
      style={{
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
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
