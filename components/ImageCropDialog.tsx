import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CROP_RATIOS, cropDataUrl, maxCropForRatio, pickClosestCropRatio, type CropRect } from '../utils/cropToAspect.js';

// アップロード直後に挟むクロップ画面（260703 クライアント合意）。AIが対応する比率のみに固定して切り抜くことで、
// 以降のAI再生成がネイティブ比率で行われ、編集のたびに構図がズレる問題を根本から防ぐ。
// 元画像に最も近い対応比率を自動判定して初期選択（おすすめ）にし、ユーザーは比率切替と位置調整ができる。

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const MAX_PREVIEW_W = 620;
const MAX_PREVIEW_H = 460;

export function ImageCropDialog({
  imageDataUrl,
  onConfirm,
  onCancel,
}: {
  imageDataUrl: string;
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [ratioKey, setRatioKey] = useState<string>('1:1');
  const [recommendedKey, setRecommendedKey] = useState<string>('1:1');
  const [offset, setOffset] = useState({ x: 0.5, y: 0.5 });
  const [busy, setBusy] = useState(false);
  const dragRef = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null);

  useEffect(() => {
    setLoadError(false);
    setDims(null);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!(w > 0) || !(h > 0)) {
        setLoadError(true);
        return;
      }
      setDims({ w, h });
      const rec = pickClosestCropRatio(w, h).key;
      setRecommendedKey(rec);
      setRatioKey(rec); // おすすめを初期選択
      setOffset({ x: 0.5, y: 0.5 });
    };
    img.onerror = () => setLoadError(true); // 破損/未対応画像で無限スピナーにしない
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  const ratio = CROP_RATIOS.find((c) => c.key === ratioKey)?.ratio ?? 1;
  const scale = dims ? Math.min(MAX_PREVIEW_W / dims.w, MAX_PREVIEW_H / dims.h, 1) : 1;
  const dispW = dims ? dims.w * scale : 0;
  const dispH = dims ? dims.h * scale : 0;
  const crop: CropRect | null = dims ? maxCropForRatio(dims.w, dims.h, ratio, offset.x, offset.y) : null;
  const cropDisp = crop
    ? { x: crop.x * scale, y: crop.y * scale, w: crop.w * scale, h: crop.h * scale }
    : null;

  // クロップ矩形のドラッグ（位置調整）。offset(0..1) を画像px換算で更新。
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !dims || !crop) return;
      const rangeX = dims.w - crop.w;
      const rangeY = dims.h - crop.h;
      const nx = rangeX > 0 ? clamp01(d.ox + (e.clientX - d.sx) / scale / rangeX) : 0.5;
      const ny = rangeY > 0 ? clamp01(d.oy + (e.clientY - d.sy) / scale / rangeY) : 0.5;
      setOffset({ x: nx, y: ny });
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
  }, [dims, crop, scale]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
      document.body.style.userSelect = 'none';
      e.preventDefault();
    },
    [offset],
  );

  const handleConfirm = async () => {
    if (!dims || !crop || busy) return;
    setBusy(true);
    try {
      const out = await cropDataUrl(imageDataUrl, crop);
      onConfirm(out);
    } finally {
      setBusy(false);
    }
  };

  const cropLabel = useMemo(() => CROP_RATIOS.find((c) => c.key === ratioKey)?.label ?? ratioKey, [ratioKey]);

  return (
    <div className="fixed inset-0 z-[9500] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="画像を切り抜き">
      <div className="w-full max-w-[720px] rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow-2xl">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">画像を切り抜き</h2>
          <span className="text-[11px] font-mono text-emerald-300">{cropLabel}</span>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-neutral-400">
          AIが対応する比率に切り抜いておくことで、編集を繰り返しても構図がズレなくなります。元画像に最も近い比率
          （おすすめ）を初期選択しています。比率の切替と、枠のドラッグで位置を調整できます。
        </p>

        {/* プレビュー＋クロップ枠 */}
        <div className="flex justify-center">
          <div className="relative select-none overflow-hidden rounded-lg bg-black" style={{ width: dispW || 320, height: dispH || 200 }}>
            {dims ? (
              <>
                <img src={imageDataUrl} alt="切り抜き対象" className="block h-full w-full" draggable={false} />
                {cropDisp && (
                  <div
                    onMouseDown={startDrag}
                    className="absolute cursor-move border-2 border-emerald-400"
                    style={{
                      left: cropDisp.x,
                      top: cropDisp.y,
                      width: cropDisp.w,
                      height: cropDisp.h,
                      boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                    }}
                    title="ドラッグで位置調整"
                  />
                )}
              </>
            ) : loadError ? (
              <div className="flex h-full w-full items-center justify-center px-4 text-center text-[11px] text-red-300">
                画像を読み込めませんでした。別の画像を選び直してください。
              </div>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-neutral-500">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
          </div>
        </div>

        {/* 比率選択 */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {CROP_RATIOS.map((c) => {
            const active = c.key === ratioKey;
            const recommended = c.key === recommendedKey;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => {
                  setRatioKey(c.key);
                  setOffset({ x: 0.5, y: 0.5 });
                }}
                className={`relative rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                  active ? 'bg-emerald-600 text-white' : 'bg-white/5 text-neutral-300 hover:bg-white/10'
                }`}
              >
                {c.label}
                {recommended && (
                  <span className="ml-1 rounded bg-emerald-500/25 px-1 text-[8px] font-black text-emerald-300">おすすめ</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg bg-white/5 px-4 py-2 text-xs font-semibold text-neutral-300 transition hover:bg-white/10 disabled:opacity-40"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!dims || busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            この比率で切り抜く
          </button>
        </div>
      </div>
    </div>
  );
}
