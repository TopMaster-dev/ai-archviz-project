import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  PAPER_SIZES,
  CUSTOM_PAPER_ID,
  paperSizeById,
  paperMmLandscape,
  isStandardPaperAspect,
} from '../utils/underlayScale.js';

/**
 * 下絵の挿入ダイアログ（260803 要望・260804/260805 資料で仕様確定）。
 *
 * 図面は「どの用紙に、どの縮尺で」描かれたかが分かれば実寸が決まる。
 * 挿入時にその2つを伺い、正しい大きさで配置する。
 *
 * 【260805 クライアント要望のフロー】
 *  1. ファイル読み込み後にこのポップアップを出す（PDFが複数ページなら何枚目かを選ぶ）
 *  2. プレビューを見ながら用紙サイズ（A0〜A3・カスタム可）と縮尺（任意の数値）を決める
 *  3. 取り込み／キャンセル
 *
 * 幅と高さは両方入力できるが、内部では常に1つの倍率で配置する（画像は歪めない）。
 * そのため一方を入れると、もう一方は画像の縦横比から自動で決まる。
 */

export interface UnderlayInsertResult {
  /** 選んだ用紙（'A0'〜'A3' または 'custom'）。 */
  paperId: string;
  /** 縮尺の分母（1/100 なら 100）。 */
  scaleDenominator: number;
  /** 用紙上の幅（mm）。カスタムのときに使う。 */
  customWidthMm?: number;
}

export function UnderlayInsertDialog({
  open,
  imageDataUrl,
  imageWidth,
  imageHeight,
  detectedPaperId,
  defaultWidthMm,
  pageCount = 1,
  pageNumber = 1,
  pageLoading = false,
  onPageChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** プレビューに出す画像（PDFは選択中ページをラスタライズしたもの）。 */
  imageDataUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  detectedPaperId?: string | null;
  /**
   * カスタム用紙のときの幅（mm）の初期値。PDFはページの実寸が分かるのでそれを入れる。
   * 空欄から始めると、規格外の用紙（長尺図面など）で必ず手入力が要る。
   */
  defaultWidthMm?: number | null;
  /** PDFの総ページ数。2以上のときだけページ選択を出す。 */
  pageCount?: number;
  pageNumber?: number;
  /** ページ差し替えの描画中。プレビューにスピナーを出す。 */
  pageLoading?: boolean;
  onPageChange?: (page: number) => void;
  onCancel: () => void;
  onConfirm: (result: UnderlayInsertResult) => void;
}) {
  const [paperId, setPaperId] = useState<string>(detectedPaperId ?? 'A3');
  /** 縮尺の分母。クライアント指定により任意の数値を受ける（プリセットに縛らない）。 */
  const [denominatorText, setDenominatorText] = useState<string>('100');
  /**
   * カスタム用紙のときの用紙上の寸法（mm）。
   * 幅・高さのどちらからでも入力できるようにするため、両方を文字列で持つ
   * （一方だけを状態にして他方を計算で出すと、入力途中に値が跳ねて打ち直せない）。
   * 画像は歪めないので、片方を打つともう片方は縦横比から自動で入る。
   */
  const [widthText, setWidthText] = useState<string>('');
  const [heightText, setHeightText] = useState<string>('');

  const standardAspect = isStandardPaperAspect(imageWidth, imageHeight);
  const aspect = imageWidth > 0 && imageHeight > 0 ? imageHeight / imageWidth : 0;

  /** 幅(mm)を入れ、高さを縦横比から追従させる。 */
  const applyWidth = (text: string, nextAspect = aspect) => {
    setWidthText(text);
    const v = Number(text);
    if (Number.isFinite(v) && v > 0 && nextAspect > 0) setHeightText(String(Math.round(v * nextAspect)));
    else if (!text.trim()) setHeightText('');
  };

  const wasOpen = useRef(false);
  useEffect(() => {
    // 開いた瞬間だけ全項目を初期化する。ページを選び直しただけで、
    // すでに入力済みの縮尺まで 100 に戻ってしまうのを避ける（下の効果で用紙だけ追従させる）。
    if (open && !wasOpen.current) {
      setPaperId(detectedPaperId ?? 'A3');
      setDenominatorText('100');
      applyWidth(defaultWidthMm && defaultWidthMm > 0 ? String(Math.round(defaultWidthMm)) : '');
    }
    wasOpen.current = open;
    // applyWidth は毎レンダー作り直されるため依存に入れない（入れると初期化が繰り返される）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, detectedPaperId, defaultWidthMm]);

  // ページを選び直すと用紙も画像サイズも変わりうる。用紙の判定と、
  // カスタム時の寸法だけを新しいページに合わせ直す（縮尺は利用者の入力を残す）。
  const prevPageRef = useRef(pageNumber);
  useEffect(() => {
    if (!open || pageNumber === prevPageRef.current) return;
    prevPageRef.current = pageNumber;
    setPaperId(detectedPaperId ?? 'A3');
    applyWidth(defaultWidthMm && defaultWidthMm > 0 ? String(Math.round(defaultWidthMm)) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageNumber, detectedPaperId, defaultWidthMm]);

  const isCustom = paperId === CUSTOM_PAPER_ID;

  const denominator = useMemo(() => {
    const v = Number(denominatorText);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [denominatorText]);

  /** 用紙上の幅（mm）。規格用紙は横想定の長辺、カスタムは入力値。 */
  const paperWidthMm = useMemo(() => {
    if (isCustom) {
      const v = Number(widthText);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    const p = paperSizeById(paperId);
    return p ? paperMmLandscape(p).widthMm : null;
  }, [isCustom, widthText, paperId]);

  /** 用紙上の高さ（mm）。画像を歪めないため、幅と画像の縦横比から決まる。 */
  const paperHeightMm = useMemo(() => {
    if (!isCustom) {
      const p = paperSizeById(paperId);
      return p ? paperMmLandscape(p).heightMm : null;
    }
    return paperWidthMm != null && aspect > 0 ? paperWidthMm * aspect : null;
  }, [isCustom, paperId, paperWidthMm, aspect]);

  /** 高さ(mm)を入れ、幅を縦横比から逆算する（幅・高さのどちらからでも指定できるように）。 */
  const applyHeight = (text: string) => {
    setHeightText(text);
    const v = Number(text);
    if (Number.isFinite(v) && v > 0 && aspect > 0) setWidthText(String(Math.round(v / aspect)));
    else if (!text.trim()) setWidthText('');
  };

  // 確定前に実寸を見せる（縮尺の指定違いに、なぞり始める前に気付けるように）。
  const preview = useMemo(() => {
    if (!paperWidthMm || !paperHeightMm || !denominator) return null;
    return {
      widthM: (paperWidthMm * denominator) / 1000,
      heightM: (paperHeightMm * denominator) / 1000,
    };
  }, [paperWidthMm, paperHeightMm, denominator]);

  if (!open) return null;

  const canConfirm = !!paperWidthMm && !!denominator && !pageLoading;

  return (
    <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/15 bg-zinc-900 shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-black uppercase tracking-widest text-white">下絵の挿入</h2>
          <button type="button" onClick={onCancel} className="rounded-lg p-1 text-neutral-400 hover:bg-white/10" aria-label="閉じる">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-dark p-4 text-xs text-neutral-300">
          {/* 1. 複数ページのPDFは、どのページを取り込むかを先に選ぶ */}
          {pageCount > 1 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <span className="text-[11px] font-bold text-neutral-400">取り込むページ</span>
              <select
                value={pageNumber}
                onChange={(e) => onPageChange?.(Number(e.target.value))}
                disabled={pageLoading}
                className="h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60 disabled:opacity-50"
              >
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} ページ目
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-neutral-500">全 {pageCount} ページ</span>
            </div>
          )}

          {/* 2. プレビューを見ながら大きさを決める */}
          <div className="relative flex min-h-[168px] items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black/40">
            {imageDataUrl ? (
              <img
                src={imageDataUrl}
                alt="下絵のプレビュー"
                className="max-h-[240px] w-auto max-w-full object-contain"
              />
            ) : (
              <span className="text-[11px] text-neutral-500">プレビューを読み込んでいます…</span>
            )}
            {pageLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <Loader2 className="h-5 w-5 animate-spin text-emerald-400" aria-label="読み込み中" />
              </div>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-neutral-500">
            図面が描かれた用紙サイズと縮尺を選んでください。この2つから実寸を計算して配置します。用紙は横向きとして扱います。
          </p>

          {/* 規格用紙でないファイルは、用紙サイズを当てはめると実寸が狂う。理由を明示する。 */}
          {!standardAspect && imageWidth > 0 && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
              このファイルの縦横比は用紙サイズ（1:1.414）と一致しません。図面の一部を切り取った画像などの可能性があるため、
              「カスタム」で幅（mm）を直接ご指定ください。
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
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">縮尺 1 /</span>
              <input
                type="number"
                min={1}
                step={1}
                value={denominatorText}
                onChange={(e) => setDenominatorText(e.target.value)}
                placeholder="100"
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60"
                title="図面の縮尺の分母。1/100 なら 100 と入力します。"
              />
              {denominatorText.trim() && !denominator && (
                <span className="mt-1 block text-[11px] font-bold text-amber-300">正の数値を入力してください。</span>
              )}
            </label>
          </div>

          {/* 用紙上の寸法。カスタムのときだけ入力でき、幅・高さのどちらからでも指定できる。 */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">用紙上の幅（mm）</span>
              <input
                type="number"
                min={1}
                value={isCustom ? widthText : paperWidthMm != null ? Math.round(paperWidthMm) : ''}
                disabled={!isCustom}
                onChange={(e) => applyWidth(e.target.value)}
                placeholder="例: 420"
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60 disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-neutral-400">用紙上の高さ（mm）</span>
              <input
                type="number"
                min={1}
                value={isCustom ? heightText : paperHeightMm != null ? Math.round(paperHeightMm) : ''}
                disabled={!isCustom}
                onChange={(e) => applyHeight(e.target.value)}
                placeholder="例: 297"
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-emerald-500/60 disabled:opacity-60"
                title="画像を歪めないため、高さを変えると幅も連動します。"
              />
            </label>
          </div>

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
              <span className="text-neutral-500">用紙サイズと縮尺を入力すると、配置される実寸を表示します。</span>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-neutral-500">
            挿入後も、左のパネルで基準点・位置・用紙サイズ・縮尺を変更できます。
          </p>
        </div>

        {/* 3. 取り込み / キャンセル */}
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
                scaleDenominator: denominator!,
                ...(isCustom && paperWidthMm ? { customWidthMm: paperWidthMm } : {}),
              })
            }
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            取り込み
          </button>
        </div>
      </div>
    </div>
  );
}
