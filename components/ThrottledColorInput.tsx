import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pipette } from 'lucide-react';
import {
  clamp01,
  hexToHsv,
  hsvToHex,
  normalizeHex,
  type Hsv,
} from '../utils/colorConvert.js';
import { useEyedropper } from '../lib/store/eyedropperStore.js';

/**
 * 3Dマテリアル用のカラー入力（260709 全面刷新）。
 *
 * 【なぜ自作ピッカーにしたか】
 * これまで使っていたブラウザ標準の `<input type="color">` には、その中の「スポイト（pen）」を
 * 使うと **ブラウザ全体が固まる** 不具合があった。原因はアプリ側ではなく Chrome 本体のバグ
 * （スポイトがマウス操作を掴んだまま離さない）で、アプリ側でいくら手を入れても直せない。
 * そこで、ネイティブ入力を完全にやめ、スポイト（pen）を一切持たない自前のカラーピッカーへ置換した。
 * ネイティブのスポイトが開けない＝あの固まりは構造上起きえない（原因非依存の確実な解消）。
 *
 * 【契約】props は従来どおり value:hex / onChange:(hex)=>void / className / disabled / title / aria-label。
 * 呼び出し側（App.tsx の巾木・ドア・ドア枠・窓枠）は無改修で差し替え可能。
 *
 * 【UI】色スウォッチのボタン → クリックでポップオーバー（彩度/明度の四角＋色相スライダー＋hex入力＋プリセット）。
 * ポップオーバーは overflow-hidden のスクロールレールで切れないよう body へ portal（position:fixed）。
 */

// 内装仕上げでよく使う色（巾木・ドア・枠・素材）を中心にしたプリセット。
const PRESETS: string[] = [
  '#ffffff', '#f7f3ea', '#ece5d3', '#d8c9a8',
  '#d9d9d9', '#9e9e9e', '#4a4a4a', '#1a1a1a',
  '#c8a06a', '#8b6f47', '#4b3621', '#2f3b52',
];

const POPOVER_W = 232;
const POPOVER_H = 306;

export function ThrottledColorInput({
  value,
  onChange,
  className,
  disabled,
  title,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  // ピッカーを開いている間の作業用 HSV（h を保持したいので value とは別に持つ：s/v を 0 にしても色相を失わない）。
  const [hsv, setHsv] = useState<Hsv>({ h: 0, s: 0, v: 0 });
  const [hexDraft, setHexDraft] = useState<string>('#000000');

  // ドラッグ中の onChange は rAF で間引く（1フレーム1回）。hex入力/プリセット/開閉は即時反映。
  const rafRef = useRef<number | null>(null);
  const pendingHexRef = useRef<string | null>(null);
  const rafCommit = useCallback((hex: string) => {
    pendingHexRef.current = hex;
    if (typeof requestAnimationFrame !== 'function') {
      onChangeRef.current(hex);
      return;
    }
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const h = pendingHexRef.current;
      if (h != null) onChangeRef.current(h);
    });
  }, []);
  useEffect(
    () => () => {
      if (rafRef.current != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current);
      }
    },
    []
  );

  const openPicker = useCallback(() => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    let top = 0;
    let left = 0;
    if (rect && typeof window !== 'undefined') {
      left = rect.left;
      top = rect.bottom + 6;
      if (left + POPOVER_W > window.innerWidth - 8) left = window.innerWidth - POPOVER_W - 8;
      if (left < 8) left = 8;
      // 下に入らなければ上へ出す
      if (top + POPOVER_H > window.innerHeight - 8) top = Math.max(8, rect.top - POPOVER_H - 6);
    }
    setPos({ top, left });
    const start = hexToHsv(value);
    setHsv(start);
    setHexDraft(normalizeHex(value) ?? '#000000');
    setOpen(true);
  }, [disabled, value]);

  // 外側クリック / Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // --- 彩度/明度の四角 ---
  const svDraggingRef = useRef(false);
  const applySvFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = svRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const s = clamp01((clientX - rect.left) / rect.width);
      const v = 1 - clamp01((clientY - rect.top) / rect.height);
      setHsv((prev) => {
        const next = { h: prev.h, s, v };
        const hex = hsvToHex(next.h, next.s, next.v);
        rafCommit(hex);
        setHexDraft(hex); // hex表示もドラッグに追従させる（古い値が残って再コミットで巻き戻るのを防ぐ）
        return next;
      });
    },
    [rafCommit]
  );
  const onSvPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    svDraggingRef.current = true;
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    applySvFromPointer(e.clientX, e.clientY);
  };
  const onSvPointerMove = (e: React.PointerEvent) => {
    if (svDraggingRef.current) applySvFromPointer(e.clientX, e.clientY);
  };
  const onSvPointerUp = (e: React.PointerEvent) => {
    svDraggingRef.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* jsdom */ }
  };

  // --- 色相スライダー ---
  const hueDraggingRef = useRef(false);
  const applyHueFromPointer = useCallback(
    (clientX: number) => {
      const el = hueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      const h = clamp01((clientX - rect.left) / rect.width) * 360;
      setHsv((prev) => {
        const next = { h, s: prev.s, v: prev.v };
        const hex = hsvToHex(next.h, next.s, next.v);
        rafCommit(hex);
        setHexDraft(hex); // hex表示もドラッグに追従させる
        return next;
      });
    },
    [rafCommit]
  );
  const onHuePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    hueDraggingRef.current = true;
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    applyHueFromPointer(e.clientX);
  };
  const onHuePointerMove = (e: React.PointerEvent) => {
    if (hueDraggingRef.current) applyHueFromPointer(e.clientX);
  };
  const onHuePointerUp = (e: React.PointerEvent) => {
    hueDraggingRef.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* jsdom */ }
  };

  // --- hex 手入力 ---
  const onHexInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setHexDraft(raw);
    const norm = normalizeHex(raw);
    if (norm) {
      setHsv(hexToHsv(norm));
      onChangeRef.current(norm);
    }
  };
  const onHexBlur = () => {
    // 無効な入力は現在の色へ戻す
    const norm = normalizeHex(hexDraft);
    if (!norm) setHexDraft(hsvToHex(hsv.h, hsv.s, hsv.v));
  };

  const applyHex = (hex: string) => {
    const norm = normalizeHex(hex);
    if (!norm) return;
    setHsv(hexToHsv(norm));
    setHexDraft(norm);
    onChangeRef.current(norm);
  };

  const currentHex = normalizeHex(value) ?? '#000000';
  const hueColor = `hsl(${Math.round(hsv.h)}, 100%, 50%)`;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => (open ? setOpen(false) : openPicker())}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={className}
        style={{ backgroundColor: value, padding: 0 }}
      />

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="カラーピッカー"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: POPOVER_W,
              zIndex: 9999,
            }}
            className="rounded-xl border border-white/10 bg-neutral-900/95 backdrop-blur p-3 shadow-2xl"
          >
            {/* 彩度/明度 */}
            <div
              ref={svRef}
              role="slider"
              aria-label="彩度・明度"
              aria-valuetext={`S ${Math.round(hsv.s * 100)}% / V ${Math.round(hsv.v * 100)}%`}
              onPointerDown={onSvPointerDown}
              onPointerMove={onSvPointerMove}
              onPointerUp={onSvPointerUp}
              style={{
                position: 'relative',
                width: '100%',
                height: 132,
                borderRadius: 8,
                cursor: 'crosshair',
                touchAction: 'none',
                backgroundColor: hueColor,
                backgroundImage:
                  'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: `${hsv.s * 100}%`,
                  top: `${(1 - hsv.v) * 100}%`,
                  width: 14,
                  height: 14,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: '50%',
                  border: '2px solid #fff',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                }}
              />
            </div>

            {/* 色相 */}
            <div
              ref={hueRef}
              role="slider"
              aria-label="色相"
              aria-valuetext={`H ${Math.round(hsv.h)}`}
              onPointerDown={onHuePointerDown}
              onPointerMove={onHuePointerMove}
              onPointerUp={onHuePointerUp}
              style={{
                position: 'relative',
                width: '100%',
                height: 14,
                marginTop: 10,
                borderRadius: 7,
                cursor: 'ew-resize',
                touchAction: 'none',
                backgroundImage:
                  'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: `${(hsv.h / 360) * 100}%`,
                  top: '50%',
                  width: 14,
                  height: 14,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: '50%',
                  border: '2px solid #fff',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                }}
              />
            </div>

            {/* hex 入力 + 現在色プレビュー + スポイト */}
            <div className="mt-3 flex items-center gap-2">
              <div
                aria-hidden="true"
                style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: currentHex }}
                className="border border-white/10 shrink-0"
              />
              <input
                type="text"
                value={hexDraft}
                onChange={onHexInput}
                onBlur={onHexBlur}
                spellCheck={false}
                aria-label="カラーコード（hex）"
                className="flex-1 min-w-0 rounded-md bg-neutral-800 border border-white/10 px-2 py-1 text-xs text-white font-mono uppercase focus:outline-none focus:border-emerald-400"
              />
              <button
                type="button"
                onClick={() => {
                  // ポップオーバーを閉じて 3D画面/画像 をクリックできるようにし、サンプリングを開始。
                  setOpen(false);
                  useEyedropper.getState().start((hex) => onChangeRef.current(hex));
                }}
                title="スポイト（3D画面や画像から色を取得）"
                aria-label="スポイトで色を取得"
                className="shrink-0 rounded-md border border-white/10 bg-neutral-800 p-1.5 text-neutral-300 hover:border-emerald-400 hover:text-white"
              >
                <Pipette size={16} />
              </button>
            </div>

            {/* プリセット */}
            <div className="mt-3 grid grid-cols-6 gap-1.5">
              {PRESETS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => applyHex(hex)}
                  title={hex}
                  aria-label={`プリセット ${hex}`}
                  style={{ backgroundColor: hex }}
                  className="w-full aspect-square rounded-md border border-white/10 cursor-pointer hover:scale-110 transition-transform"
                />
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
