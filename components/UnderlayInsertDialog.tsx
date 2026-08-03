import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  PAPER_SIZES,
  SCALE_DENOMINATORS,
  CUSTOM_PAPER_ID,
  paperSizeById,
  paperMmLandscape,
  isStandardPaperAspect,
} from '../utils/underlayScale.js';

/**
 * 下絵の挿入ダイアログ（260803 クライアント要望・管理表124行目／260804 資料で仕様確定）。
 *
 * 従来は画像を選ぶと即座に貼り付けられ、実寸は後から「幅(mm)」を手入力して合わせる必要があった。
 * 図面は「どの用紙に、どの縮尺で」描かれたかが分かれば実寸が決まるので、挿入時にその2つを伺う。
 *
 * 【クライアント指定】
 *  - 用紙は横（ランドスケープ）想定。
 *  - 読み込んだファイルの縦横比がA判（1:1.414）でない場合は「カスタム（手入力）」にする。
 */

export interface UnderlayInsertResult {
  /** 選んだ用紙（'A0'〜'A3' または 'custom'）。 */
  paperId: string;
  /** 縮尺の分母（1/100 なら 100）。 */
  scaleDenominator: number;
  /** カスタムのときの用紙上の幅（mm）。規格用紙のときは未設定。 */
  customWidthMm?: number;
}

export function UnderlayInsertDialog({
  open,
  imageWidth,
  imageHeight,
  detectedPaperId,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** 取り込む画像の画素数。用紙の判定と実寸プレビューに使う。 */
  imageWidth: number;
  imageHeight: number;
  /** PDFの実測、または画像の縦横比から決めた初期選択。 */
  detectedPaperId?: string | null;
  onCancel: () => void;
  onConfirm: (result: UnderlayInsertResult) => void;
}) {
  const [paperId, setPaperId] = useState<string>(detectedPaperId ?? 'A3');
  const [denominator, setDenominator] = useState<number>(100);
  const [customWidth, setCustomWidth] = useState<string>('');

  const standardAspect = isStandardPaperAspect(imageWidth, imageHeight);

  useEffect(() => {
    if (!open) return;
    setPaperId(detectedPaperId ?? 'A3');
    setDenominator(100);
    setCustomWidth('');
  }, [open, detectedPaperId]);

  const isCustom = paperId === CUSTOM_PAPER_ID;
  const customWidthMm = useMemo(() => {
    const v = Number(customWidth);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [customWidth]);

  // 用紙上の幅（mm）。規格用紙は横想定の長辺、カスタムは入力値。
  const paperWidthMm = useMemo(() => {
    if (isCustom) return customWidthMm;
    const p = paperSizeById(paperId);
    return p ? paperMmLandscape(p).widthMm : null;
  }, [isCustom, customWidthMm, paperId]);

  // 確定前に実寸を見せる（縮尺の指定違いに、なぞり始める前に気付けるように）。
  const preview = useMemo(() => {
    if (!paperWidthMm || !(imageWidth > 0) || !(imageHeight > 0)) return null;
    const mmPerPx = (paperWidthMm / imageWidth) * denominator;
    return { widthM: (imageWidth * mmPerPx) / 1000, heightM: (imageHeight * mmPerPx) / 1000 };
  }, [paperWidthMm, imageWidth, imageHeight, denominator]);

  if (!open) return null;

  const canConfirm = !!paperWidthMm && denominator > 0;

  return (
    <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/15 bg-zinc-900 shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-black uppercase tracking-widest text-white">下絵の挿入</h2>
          <button type="button" onClick={onCancel} className="rounded-lg p-1 text-neutral-400 hover:bg-white/10" aria-label="閉じる">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-4 text-xs text-neutral-300">
          <p className="text-[11px] leading-relaxed text-neutral-500">
            図面が描かれた用紙サイズと縮尺を選んでください。この2つから実寸を計算し、正しい大きさで配置します。
            用紙は横向きとして扱います。
          </p>

          {/* 規格用紙でないファイルは、そのまま用紙サイズを当てはめると実寸が狂う。理由を明示する。 */}
          {!standardAspect && imageWidth > 0 && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
              このファイルの縦横比は用紙サイズ（1:1.414）と一致しません。図面の一部を切り取った画像などの可能性があるため、
              「カスタム」で用紙上の幅（mm）を直接ご指定ください。
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">用紙 / 画像サイズ</span>
              <select
                value={paperId}
                onChange={(e) => setPaperId(e.target.value)}
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60"
              >
                {PAPER_SIZES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}（{paperMmLandscape(p).widthMm} × {paperMmLandscape(p).heightMm} mm）
                  </option>
                ))}
                <option value={CUSTOM_PAPER_ID}>カスタム（手入力）</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">縮尺</span>
              <select
                value={denominator}
                onChange={(e) => setDenominator(Number(e.target.value))}
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60"
              >
                {SCALE_DENOMINATORS.map((d) => (
                  <option key={d} value={d}>
                    1 / {d}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {isCustom && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">用紙上の幅（mm）</span>
              <input
                type="number"
                min={1}
                value={customWidth}
                onChange={(e) => setCustomWidth(e.target.value)}
                placeholder="例: 420"
                autoFocus
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60"
              />
              {customWidth.trim() && !customWidthMm && (
                <span className="mt-1 block text-[11px] font-bold text-amber-300">正の数値を入力してください。</span>
              )}
            </label>
          )}

          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px]">
            {preview ? (
              <>
                <span className="text-neutral-400">この設定で下絵は </span>
                <b className="font-mono text-emerald-400">
                  約 {preview.widthM.toFixed(1)} m × {preview.heightM.toFixed(1)} m
                </b>
                <span className="text-neutral-400"> になります。</span>
              </>
            ) : (
              <span className="text-neutral-500">用紙サイズと縮尺を選ぶと、配置される実寸を表示します。</span>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-neutral-500">
            挿入後も、左のパネルで基準点・位置・用紙サイズ・縮尺を変更できます。
          </p>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/15 px-3 py-2 text-xs font-bold text-neutral-300 transition hover:bg-white/10"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() =>
              canConfirm &&
              onConfirm({
                paperId,
                scaleDenominator: denominator,
                ...(isCustom && customWidthMm ? { customWidthMm } : {}),
              })
            }
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            この内容で下絵を挿入
          </button>
        </div>
      </div>
    </div>
  );
}
