import { useCallback, useEffect, useRef, useState } from 'react';
import { PencilRuler, Box, Sparkles, Save, FolderPlus, X, ChevronLeft, ChevronRight, Move } from 'lucide-react';

/**
 * 操作ガイド（管理表 row 73）。
 * 260623: 一度きりの表示ではなく、右上の「?」からいつでも見返せるスライド形式に変更。
 * 260701 クライアント要望: 背景オーバーレイを撤去し、マウスドラッグで「移動」「拡大縮小」できる
 *   フローティングパネルにする。これによりガイドを見ながら裏の作業画面を操作できる。
 *   2D/3Dビューにあった操作ガイドは廃止し、このパネルへ統合（各スライドは後日クライアント支給の画像に差し替え）。
 * 表示制御は親（HomeScreen / App エディタ）が行う（open/onClose）。初回自動表示の判定は親が SEEN_KEY で行う。
 */
export const ONBOARDING_SEEN_KEY = 'arise.onboarding.seen.v1';

type Slide = {
  icon: typeof FolderPlus;
  step: string;
  title: string;
  desc: string;
  /** 後日差し替え用のフルパネル画像URL（例 /onboarding/01.jpg）。未設定時はプレースホルダ表示。 */
  image?: string;
};

const SLIDES: Slide[] = [
  { icon: FolderPlus, step: '1', title: 'プロジェクトを作成', desc: '「＋ 新規作成」で「空間デザイン」または「写真をAI編集」を選んで作成します。' },
  { icon: PencilRuler, step: '2', title: '2Dで描く', desc: '2Dビューで部屋の輪郭・建具（ドア/窓）・家具を配置します。' },
  { icon: Box, step: '3', title: '3Dへ立ち上げる', desc: '3Dビューへ自動生成。素材・天井高・梁などを設定します。' },
  { icon: Sparkles, step: '4', title: 'AIで仕上げる', desc: 'AIレンダリング／画像編集でフォトリアルなパースを生成。見積もりまで一気通貫。' },
  { icon: Save, step: '5', title: '保存・共有', desc: '編集は自動保存。「ホームに戻る」で確実に保存し、閲覧用URLで共有できます。' },
];

const MIN_W = 320;
const MAX_W = 1100;
const DEFAULT_W = 600;

export function OnboardingGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [width, setWidth] = useState(DEFAULT_W);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null);
  const resizeRef = useRef<null | { sx: number; ow: number }>(null);

  // 開くたびに先頭スライド＋中央寄せ＋既定サイズに戻す（前回ドラッグで画面外へ出していても必ず見える）。
  useEffect(() => {
    if (!open) return;
    setIdx(0);
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const w = Math.min(DEFAULT_W, Math.max(MIN_W, vw - 40));
    setWidth(w);
    setPos({ x: Math.max(12, (vw - w) / 2), y: 72 });
  }, [open]);

  // マウスドラッグでの移動・リサイズ。window で move/up を拾い、パネル外でも追従させる。
  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const nx = dragRef.current.ox + (e.clientX - dragRef.current.sx);
        const ny = dragRef.current.oy + (e.clientY - dragRef.current.sy);
        // ヘッダが必ず掴める位置に軽くクランプ（画面外へ完全に出さない）。
        const maxX = window.innerWidth - 120;
        const maxY = window.innerHeight - 44;
        setPos({ x: Math.min(maxX, Math.max(-(width - 120), nx)), y: Math.min(maxY, Math.max(0, ny)) });
      } else if (resizeRef.current) {
        const w = Math.min(MAX_W, Math.max(MIN_W, resizeRef.current.ow + (e.clientX - resizeRef.current.sx)));
        setWidth(w);
      }
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
  }, [open, width]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (!pos) return;
      dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
      document.body.style.userSelect = 'none';
      e.preventDefault();
    },
    [pos],
  );
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      resizeRef.current = { sx: e.clientX, ow: width };
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    },
    [width],
  );

  if (!open || !pos) return null;

  const slide = SLIDES[idx];
  const Icon = slide.icon;
  const go = (d: number) => setIdx((i) => (i + d + SLIDES.length) % SLIDES.length);

  return (
    // 背景オーバーレイ無し＝ガイドを見ながら裏の作業画面を操作できる（260701・クライアント要望）。
    <div
      className="fixed z-[10200] overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl"
      style={{ left: pos.x, top: pos.y, width }}
      role="dialog"
      aria-label="操作ガイド"
    >
      {/* ヘッダ＝ドラッグハンドル（マウスドラッグで移動）。 */}
      <div
        onMouseDown={startDrag}
        className="flex cursor-move select-none items-center gap-2 border-b border-white/10 bg-neutral-800/80 px-3 py-2"
      >
        <Move className="h-3.5 w-3.5 text-neutral-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-neutral-300">操作ガイド</span>
        <button
          type="button"
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="閉じる"
          className="ml-auto rounded-md p-1 text-neutral-300 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* フルパネル（画像 or プレースホルダ）。画像が揃ったら slide.image を設定すると全面表示に切替わる。 */}
      <div className="relative flex aspect-[16/9] items-center justify-center bg-gradient-to-br from-emerald-500/[0.08] to-neutral-900">
        {slide.image ? (
          <img src={slide.image} alt={slide.title} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="px-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-300">
              <Icon className="h-8 w-8" />
            </div>
            <p className="text-xs font-bold tracking-wider text-emerald-400">
              STEP {slide.step} / {SLIDES.length}
            </p>
            <h3 className="mt-1 text-xl font-bold">{slide.title}</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-300">{slide.desc}</p>
            <p className="mt-4 text-[10px] text-neutral-600">※ ガイド画像は準備中です</p>
          </div>
        )}

        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="前へ"
          className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/45 p-2 text-white shadow-lg transition hover:bg-black/70"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          aria-label="次へ"
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/45 p-2 text-white shadow-lg transition hover:bg-black/70"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>

      {/* ドットインジケータ */}
      <div className="flex items-center justify-center gap-2 py-3">
        {SLIDES.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setIdx(i)}
            aria-label={`${i + 1}枚目を表示`}
            className={`h-2 rounded-full transition-all ${
              i === idx ? 'w-5 bg-emerald-400' : 'w-2 bg-white/25 hover:bg-white/40'
            }`}
          />
        ))}
      </div>

      {/* リサイズハンドル（右下角・マウスドラッグで拡大縮小）。 */}
      <div
        onMouseDown={startResize}
        role="separator"
        aria-label="サイズ変更"
        title="ドラッグでサイズ変更"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
        style={{ background: 'linear-gradient(135deg, transparent 45%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.4) 60%, transparent 60%)' }}
      />
    </div>
  );
}
