import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  PAPER_SIZES,
  SCALE_PRESETS,
  paperSizeById,
  paperMmForImage,
  parseScaleDenominator,
} from '../utils/underlayScale.js';

/**
 * 下絵の挿入ダイアログ（260803 クライアント要望・管理表124行目）。
 *
 * 従来は画像を選ぶと即座に貼り付けられ、実寸は後から「幅(mm)」を手入力して合わせる必要があった。
 * 図面は「どの用紙に、どの縮尺で」描かれたかが分かれば実寸が決まるので、
 * 挿入時にその2つを伺い、自動で正しい大きさに置く。
 *
 * PDFは用紙寸法をファイル自身が持っているため、検出した用紙を初期選択する（変更も可）。
 * 用紙の向きは画像の縦横比から自動判定する（クライアント指定）。
 */

export interface UnderlayInsertResult {
  /** 選んだ用紙（idのみ。実寸は縦横比とあわせて確定する）。 */
  paperId: string;
  /** 縮尺の分母（1/100 なら 100）。 */
  scaleDenominator: number;
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
  /** 取り込む画像の画素数。用紙の向きの自動判定と、プレビュー表示に使う。 */
  imageWidth: number;
  imageHeight: number;
  /** PDFから用紙が判別できた場合の初期選択。判別できなければ null。 */
  detectedPaperId?: string | null;
  onCancel: () => void;
  onConfirm: (result: UnderlayInsertResult) => void;
}) {
  const [paperId, setPaperId] = useState<string>(detectedPaperId ?? 'A3');
  const [scaleChoice, setScaleChoice] = useState<string>('100');
  const [customScale, setCustomScale] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setPaperId(detectedPaperId ?? 'A3');
    setScaleChoice('100');
    setCustomScale('');
  }, [open, detectedPaperId]);

  const paper = paperSizeById(paperId);
  const isCustom = scaleChoice === 'custom';
  const denominator = useMemo(
    () => (isCustom ? parseScaleDenominator(customScale) : Number(scaleChoice)),
    [isCustom, customScale, scaleChoice],
  );

  // 選んだ内容で下絵が実寸何mになるかを先に見せる（入力ミスにその場で気付けるように）。
  const preview = useMemo(() => {
    if (!paper || !denominator || !(imageWidth > 0) || !(imageHeight > 0)) return null;
    const { widthMm, heightMm } = paperMmForImage(paper, imageWidth, imageHeight);
    return {
      widthM: (widthMm * denominator) / 1000,
      heightM: (heightMm * denominator) / 1000,
      landscape: imageWidth >= imageHeight,
    };
  }, [paper, denominator, imageWidth, imageHeight]);

  if (!open) return null;

  const canConfirm = !!paper && !!denominator;

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
            用紙の向きは画像の縦横比から自動で判定します。
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">用紙サイズ</span>
              <select
                value={paperId}
                onChange={(e) => setPaperId(e.target.value)}
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60"
              >
                {PAPER_SIZES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}（{p.shortMm} × {p.longMm} mm）
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">縮尺</span>
              <select
                value={scaleChoice}
                onChange={(e) => setScaleChoice(e.target.value)}
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60"
              >
                {SCALE_PRESETS.map((d) => (
                  <option key={d} value={String(d)}>
                    1/{d}
                  </option>
                ))}
                <option value="custom">任意入力</option>
              </select>
            </label>
          </div>

          {isCustom && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">縮尺（任意入力）</span>
              <input
                type="text"
                value={customScale}
                onChange={(e) => setCustomScale(e.target.value)}
                placeholder="例: 1/150"
                autoFocus
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60"
              />
              {customScale.trim() && !denominator && (
                <span className="mt-1 block text-[11px] font-bold text-amber-300">
                  「1/150」のように入力してください。
                </span>
              )}
            </label>
          )}

          {/* 入力の結果どうなるかを先に見せる（挿入してから間違いに気付くのを防ぐ）。 */}
          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px]">
            {preview ? (
              <>
                <span className="text-neutral-400">この設定で下絵は </span>
                <b className="font-mono text-emerald-400">
                  約 {preview.widthM.toFixed(1)} m × {preview.heightM.toFixed(1)} m
                </b>
                <span className="text-neutral-400"> になります（{preview.landscape ? '横向き' : '縦向き'}と判定）。</span>
              </>
            ) : (
              <span className="text-neutral-500">用紙サイズと縮尺を選ぶと、配置される実寸を表示します。</span>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-neutral-500">
            図面の一部だけを切り取った画像など、用紙サイズに当てはまらない場合は、挿入後に「幅(mm)」で調整してください。
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
            onClick={() => canConfirm && onConfirm({ paperId, scaleDenominator: denominator! })}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            この内容で下絵を挿入
          </button>
        </div>
      </div>
    </div>
  );
}
