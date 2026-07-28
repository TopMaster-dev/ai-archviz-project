import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Search, X } from 'lucide-react';

/**
 * 画像内の「探したい対象」を矩形で指定してから検索するためのピッカー（260728 クライアント要望①）。
 * Google レンズ相当の操作感。
 *
 * なぜ必要か（UXではなく精度の問題）:
 * Cloud Vision の Web Detection は「画像全体」で照合するため、部屋全体の写真をそのまま送ると
 * 「部屋の風景」として照合され、椅子1脚を特定することはほぼできない。
 * 対象だけを切り出して送ることで、はじめて商品単位の逆画像検索が成立する。
 *
 * 返す画像は「表示上の座標」ではなく元画像の解像度で切り出す（縮小表示の影響を受けない）。
 */

export interface ImageRegionPickerProps {
  /** 対象画像（data URL または http(s) URL）。 */
  imageUrl: string;
  /** 切り出した画像（data URL）を受け取る。範囲未指定なら画像全体が渡る。 */
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
  /** 実行中はボタンを無効化して二重送信を防ぐ。 */
  busy?: boolean;
}

interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 表示座標の2点から正規化矩形（0〜1）を作る。ドラッグ方向に依らず正の幅・高さにする。 */
function rectFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: { width: number; height: number },
): NormRect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x: clamp01(x0 / box.width),
    y: clamp01(y0 / box.height),
    w: clamp01((x1 - x0) / box.width),
    h: clamp01((y1 - y0) / box.height),
  };
}

/** 元画像の解像度で矩形を切り出して data URL を返す。範囲が極小・未指定なら画像全体を返す。 */
async function cropToDataUrl(imageUrl: string, rect: NormRect | null): Promise<string> {
  const img = new Image();
  img.crossOrigin = 'anonymous'; // http(s) 画像でも canvas を汚染させない
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    img.src = imageUrl;
  });
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  // 範囲が無い／小さすぎる（誤クリック相当）ときは全体を返す。
  const useWhole = !rect || rect.w * nw < 8 || rect.h * nh < 8;
  const sx = useWhole ? 0 : Math.round(rect!.x * nw);
  const sy = useWhole ? 0 : Math.round(rect!.y * nh);
  const sw = useWhole ? nw : Math.max(1, Math.round(rect!.w * nw));
  const sh = useWhole ? nh : Math.max(1, Math.round(rect!.h * nh));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像の切り出しに失敗しました。');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/png');
}

export function ImageRegionPicker({ imageUrl, onConfirm, onCancel, busy }: ImageRegionPickerProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<NormRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // 「切り出し中に閉じられた」ことを記録し、遅れて解決した処理が検索を始めないようにする
  // （260728 敵対レビュー C6: Esc で閉じても cropToDataUrl の解決後に onConfirm が走っていた）。
  const abortedRef = useRef(false);

  const cancel = useCallback(() => {
    abortedRef.current = true;
    onCancel();
  }, [onCancel]);

  // Esc で閉じる（他のモーダルと同じ操作感）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  const pointFromEvent = (e: React.PointerEvent) => {
    const el = frameRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, box: { width: r.width, height: r.height } };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy || working) return;
    const p = pointFromEvent(e);
    if (!p) return;
    // ポインタを捕捉して、枠外へドラッグしても追従させる。
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startRef.current = { x: p.x, y: p.y };
    setDragging(true);
    setRect(rectFromPoints(startRef.current, startRef.current, p.box));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !startRef.current) return;
    const p = pointFromEvent(e);
    if (!p) return;
    setRect(rectFromPoints(startRef.current, { x: p.x, y: p.y }, p.box));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 既に解放済みでも問題ない */
    }
    setDragging(false);
    startRef.current = null;
  };

  const confirm = useCallback(
    async (whole: boolean) => {
      if (busy || working) return;
      setWorking(true);
      setError(null);
      try {
        const cropped = await cropToDataUrl(imageUrl, whole ? null : rect);
        if (abortedRef.current) return; // 切り出し中に閉じられた＝検索は開始しない
        onConfirm(cropped);
      } catch (e) {
        setError(e instanceof Error ? e.message : '切り出しに失敗しました。');
      } finally {
        setWorking(false);
      }
    },
    [busy, working, imageUrl, rect, onConfirm],
  );

  const hasRect = !!rect && rect.w > 0.01 && rect.h > 0.01;

  // 右レールの <aside> は transform を持つため、その内側だと fixed の基準がレール自身になり、
  // さらに overflow-hidden で切り取られてボタンに触れなくなる（260728 敵対レビュー C1）。
  // 他のモーダル（ImageCropDialog / HighResExportDialog）と同様に body 直下へ出す。
  return createPortal(
    <div className="fixed inset-0 z-[10010] flex items-center justify-center bg-black/80 p-4">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-2xl border border-white/15 bg-[#0c0c0c] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-emerald-400" />
            <span className="text-sm font-bold text-neutral-100">画像から商品を特定</span>
          </div>
          <button
            type="button"
            onClick={cancel}
            aria-label="閉じる"
            className="rounded p-1 text-neutral-400 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 px-4 pt-3">
          <p className="text-[11px] leading-relaxed text-neutral-400">
            探したい対象を<strong className="text-neutral-200">ドラッグで囲んで</strong>ください。範囲を絞るほど特定精度が上がります。
            部屋全体のままでは「風景」として照合され、個別の商品を特定できないことがあります。
          </p>
        </div>

        {/* 画像＋選択枠。画像は縮小表示だが、切り出しは元解像度で行う。 */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div
            ref={frameRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="relative mx-auto inline-block cursor-crosshair select-none touch-none"
          >
            <img
              src={imageUrl}
              alt="検索対象"
              draggable={false}
              className="max-h-[52vh] w-auto max-w-full rounded-lg border border-white/10 object-contain"
            />
            {rect && rect.w > 0 && rect.h > 0 && (
              <>
                {/* 選択範囲の「外側」だけを4枚の暗幕で覆う。画像を再描画しないので、
                    背景画像の位置合わせのような崩れやすい計算が要らない（確実に一致する）。 */}
                {(
                  [
                    { left: 0, top: 0, width: '100%', height: `${rect.y * 100}%` },
                    { left: 0, top: `${(rect.y + rect.h) * 100}%`, width: '100%', bottom: 0 },
                    { left: 0, top: `${rect.y * 100}%`, width: `${rect.x * 100}%`, height: `${rect.h * 100}%` },
                    {
                      left: `${(rect.x + rect.w) * 100}%`,
                      top: `${rect.y * 100}%`,
                      right: 0,
                      height: `${rect.h * 100}%`,
                    },
                  ] as React.CSSProperties[]
                ).map((style, i) => (
                  <div key={i} className="pointer-events-none absolute bg-black/55" style={style} />
                ))}
                <div
                  className="pointer-events-none absolute rounded-sm border-2 border-emerald-400"
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.w * 100}%`,
                    height: `${rect.h * 100}%`,
                  }}
                />
              </>
            )}
          </div>
        </div>

        {error && <p className="shrink-0 px-4 text-[11px] text-red-400">{error}</p>}

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
          {hasRect && (
            <button
              type="button"
              onClick={() => setRect(null)}
              disabled={busy || working}
              className="rounded-lg px-3 py-2 text-[11px] font-bold text-neutral-400 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
            >
              範囲をやり直す
            </button>
          )}
          <button
            type="button"
            onClick={() => void confirm(true)}
            disabled={busy || working}
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[11px] font-bold text-neutral-200 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            画像全体で検索
          </button>
          <button
            type="button"
            onClick={() => void confirm(false)}
            disabled={busy || working || !hasRect}
            title={hasRect ? undefined : 'まず対象をドラッグで囲んでください'}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-[11px] font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy || working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            この範囲で検索
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
