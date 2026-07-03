import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import { downscaleDataUrlIfNeeded } from '../utils/downscaleDataUrl.js';
import { ensureDataUrl } from '../lib/db/aiRenderStorage.js';
import {
  describePixelAspect,
  EXPORT_GEMINI_IMAGE_SIZE,
  EXPORT_PRESETS_16_9,
  EXPORT_PREVIEW_DESCRIPTION,
  EXPORT_PREVIEW_LABEL,
  EXPORT_PREVIEW_OPTION_ID,
  EXPORT_RENDER_INPUT_MAX_SIDE,
  EXPORT_UPSCALE_PROMPT,
  exportPaperFooterLines,
  exportPresetFooterLines,
  exportPresetsForRatio,
  exportPreviewFooterLines,
  type ExportPreset16x9,
} from '../utils/printExportSpec.js';
import { pickClosestCropRatio } from '../utils/cropToAspect.js';
import { aspectLabelForKey, ratioValueForKey } from '../utils/renderAspect.js';
import { paperPixelDims, type PaperOrientation, type PaperSize } from '../utils/paperExport.js';
import { resizeDataUrlToSize } from '../utils/resizeDataUrl.js';
import { fitDataUrlToSize } from '../utils/fitDataUrl.js';
import { applyFreePlanOutputLimits } from '../utils/freePlanImage.js';
import {
  ENABLE_FREE_PLAN_HIRES_DL_LIMIT,
  FREE_PLAN_HIRES_DL_PER_MONTH,
  hiResRemaining,
  incrementHiResDownloadCount,
  isOverHiResLimit,
} from '../utils/freePlanHiResLimit.js';
import { buildPreviewFileName, buildHiResFileName, buildPaperFileName } from '../utils/exportFileName.js';

// 用紙サイズ書き出し（第3段 260703）。対応比率で生成した画像を用紙枠へ余白付きで配置する。
const PAPER_PRESETS: { paper: PaperSize; dpi: number; label: string }[] = [
  { paper: 'A3', dpi: 300, label: 'A3・300dpi（大判プレゼン）' },
  { paper: 'A4', dpi: 300, label: 'A4・300dpi（標準）' },
];

const PRESET_COUNT = EXPORT_PRESETS_16_9.length;
const PAPER_COUNT = PAPER_PRESETS.length;
// 選択肢の並び: [dpiプリセット×PRESET_COUNT][用紙×PAPER_COUNT][プレビュー]。
const PAPER_START = PRESET_COUNT;
const PREVIEW_INDEX = PRESET_COUNT + PAPER_COUNT;

type Props = {
  open: boolean;
  onClose: () => void;
  sourceImageDataUrl: string | null;
  /** ダウンロード（書き出し）成功時。暗黙的フィードバック（採用＝good）の記録に使う（管理表 row 210/216）。 */
  onExported?: () => void;
  /** 高解像度DL月次制限の判定用（260624）。プラン種別とログインユーザーID。 */
  plan?: string | null;
  userId?: string | null;
  /** プレビューPNGの書き出しファイル名に使うプロジェクト名（260625）。 */
  projectName?: string | null;
};

/** 書き出し完了後に保持するダウンロード対象（再ダウンロード用・260625 #4）。 */
type ExportResult = { url: string; fileName: string; kind: 'preview' | 'hiRes' };

export function HighResExportDialog({
  open,
  onClose,
  sourceImageDataUrl,
  onExported,
  plan,
  userId,
  projectName,
}: Props) {
  const isFreePlan = plan === 'free';
  // 高解像度DLの今月残り回数（フリープランのみ・対象外は Infinity）。表示はダイアログを開いた時点の値。
  const hiResLeft = hiResRemaining(userId, isFreePlan);
  const showHiResLimit = ENABLE_FREE_PLAN_HIRES_DL_LIMIT && isFreePlan;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(PREVIEW_INDEX);
  const [sourceNatural, setSourceNatural] = useState<{ w: number; h: number } | null>(null);
  const [sourceNaturalLoading, setSourceNaturalLoading] = useState(false);
  // #4: 書き出し完了後のダウンロード対象を保持し、保存をキャンセルしても再ダウンロードできるようにする
  // （高コストな高解像度の再レンダを無駄にしない）。
  const [result, setResult] = useState<ExportResult | null>(null);

  // 書き出し比率は「元画像の実寸から最も近い対応比率」で決める（第2段 260703）。
  // 3Dレンダ由来なら選択したレンダ比率に、写真編集由来なら（第1段の）クロップ比率に自然に一致する。
  // 読み込み前は 16:9 相当（従来どおり）。
  const exportRatioKey = sourceNatural
    ? pickClosestCropRatio(sourceNatural.w, sourceNatural.h).key
    : '16:9';
  const presets = useMemo(
    () => exportPresetsForRatio(ratioValueForKey(exportRatioKey)),
    [exportRatioKey],
  );

  const isPreview = selectedIndex === PREVIEW_INDEX;
  const isPaper = selectedIndex >= PAPER_START && selectedIndex < PREVIEW_INDEX;
  const dpiPreset: ExportPreset16x9 | null =
    !isPreview && !isPaper ? (presets[selectedIndex] ?? presets[0]!) : null;
  const paperPreset = isPaper ? (PAPER_PRESETS[selectedIndex - PAPER_START] ?? PAPER_PRESETS[0]!) : null;
  // 用紙の向きは「生成に使う対応比率」から決める（横長比率→横向き用紙）。exportRatioKey は sourceNatural から
  // 導かれるが、読込前/失敗時も 16:9 にフォールバックし、生成される画像の向きと必ず一致する（正方は縦向き扱い）。
  const paperOrientation: PaperOrientation = ratioValueForKey(exportRatioKey) > 1 ? 'landscape' : 'portrait';
  const paperRatioLabel = paperOrientation === 'landscape' ? '1.414 : 1' : '1 : 1.414';
  const paperDims = paperPreset ? paperPixelDims(paperPreset.paper, paperPreset.dpi, paperOrientation) : null;

  useEffect(() => {
    if (open) {
      setSelectedIndex(PREVIEW_INDEX);
      setResult(null);
      setError(null);
    }
  }, [open]);

  // プリセット変更時は前回のダウンロード結果をクリア（別設定の古い結果を再ダウンロードさせない）。
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [selectedIndex]);

  useEffect(() => {
    if (!open || !sourceImageDataUrl) {
      setSourceNatural(null);
      setSourceNaturalLoading(false);
      return;
    }
    setSourceNaturalLoading(true);
    setSourceNatural(null);
    const img = new Image();
    img.onload = () => {
      setSourceNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setSourceNaturalLoading(false);
    };
    img.onerror = () => {
      setSourceNatural(null);
      setSourceNaturalLoading(false);
    };
    img.src = sourceImageDataUrl;
  }, [open, sourceImageDataUrl]);

  const width = isPreview ? (sourceNatural?.w ?? 0) : isPaper ? (paperDims?.w ?? 0) : dpiPreset!.width;
  const height = isPreview ? (sourceNatural?.h ?? 0) : isPaper ? (paperDims?.h ?? 0) : dpiPreset!.height;
  const contentAspectLabel = aspectLabelForKey(exportRatioKey);
  const aspectLabel = isPaper ? `${paperPreset!.paper}（${paperRatioLabel}）` : contentAspectLabel;
  // 用紙は「用紙比率 / 内側の画像比率」を示す（ピクセル実比の丸めで汚い表記になるのを避ける）。
  const aspectDesc = isPaper
    ? `画像 ${contentAspectLabel}`
    : width > 0 && height > 0
      ? describePixelAspect(width, height)
      : '—';

  const footerLines = isPreview
    ? exportPreviewFooterLines()
    : isPaper
      ? exportPaperFooterLines(paperPreset!.paper, contentAspectLabel, paperDims ?? { w: 0, h: 0 }, paperRatioLabel)
      : exportPresetFooterLines(dpiPreset!, contentAspectLabel);

  // #4: 保持済みの result を使ってダウンロードをトリガー（再生成・API 呼び出し・カウント消費なし）。
  // ブラウザの「保存ダイアログ」をキャンセルしても、これで何度でも保存し直せる。
  const triggerDownload = (res: ExportResult) => {
    try {
      const a = document.createElement('a');
      a.href = res.url;
      a.download = res.fileName;
      a.click();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ダウンロードエラー');
    }
  };

  const runExport = async () => {
    if (!sourceImageDataUrl) {
      setError('書き出す画像がありません。');
      return;
    }
    setError(null);
    // 履歴がURL（クラウド保存）の場合に備え、書き出し前に base64 データURL化（DL/canvas 用）。失敗時は元の値。
    const src = await ensureDataUrl(sourceImageDataUrl);

    if (isPreview) {
      // プレビューは再生成しない＝即時。結果を保持してダイアログは閉じない（再ダウンロード可能・#4）。
      const previewResult: ExportResult = {
        url: src,
        fileName: buildPreviewFileName(projectName), // 日付＋プロジェクト名＋.png
        kind: 'preview',
      };
      setResult(previewResult);
      triggerDownload(previewResult);
      onExported?.();
      return;
    }

    setBusy(true);
    try {
      const inputImage = await downscaleDataUrlIfNeeded(
        src,
        EXPORT_RENDER_INPUT_MAX_SIDE
      );
      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({
          image: inputImage,
          // 第3段: プレビュー画像の構図を忠実に保つ img2img 用プロンプト（創作し直さない）。
          prompt: EXPORT_UPSCALE_PROMPT,
          // 生成は常に「対応比率」で行う。用紙は生成後に枠へ収める（Gemini は用紙比率を直接生成不可）。
          aspectRatio: exportRatioKey,
          imageSize: EXPORT_GEMINI_IMAGE_SIZE,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '書き出しに失敗しました');
      // トークン計測（row 58・無効時は no-op）。高解像度書き出しも生成1回。
      void recordAiUsage({ feature: 'export', usage: data.usage, model: data.model, imageCount: 1 });
      let url = data.url as string;
      // 用紙: 対応比率の生成画像を用紙枠へ contain（白余白）で配置。dpi プリセット: 目標ピクセルへリサイズ。
      let fileName: string;
      if (isPaper) {
        const pd = paperDims ?? paperPixelDims(paperPreset!.paper, paperPreset!.dpi, paperOrientation);
        url = await fitDataUrlToSize(url, pd.w, pd.h, 'contain', '#ffffff');
        fileName = buildPaperFileName(projectName, {
          paper: paperPreset!.paper,
          dpi: paperPreset!.dpi,
          width: pd.w,
          height: pd.h,
        });
      } else {
        const p = dpiPreset!;
        url = await resizeDataUrlToSize(url, p.width, p.height);
        fileName = buildHiResFileName(projectName, { dpi: p.dpi, width: p.width, height: p.height });
      }
      // フリープラン: 今月の無償高解像度DL（3回）超過時は、解像度は維持したまま透かしのみ合成（260624）。
      if (isOverHiResLimit(userId, isFreePlan)) {
        url = await applyFreePlanOutputLimits(url, Number.MAX_SAFE_INTEGER);
      }
      // #4: 高コストな再レンダ結果を保持し、保存をキャンセルしても再ダウンロードできるようにする（ダイアログは閉じない）。
      const exportResult: ExportResult = {
        url,
        fileName,
        kind: 'hiRes',
      };
      setResult(exportResult);
      triggerDownload(exportResult);
      // 消費はレンダー1回につき1回だけ（再ダウンロードでは消費しない・成功時のみ）。
      incrementHiResDownloadCount(userId, isFreePlan);
      onExported?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'エラー');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const pixelSummary =
    (isPreview || isPaper) && sourceNaturalLoading ? (
      <span className="text-neutral-500">読み込み中…</span>
    ) : width > 0 && height > 0 ? (
      <span className="text-white font-mono">
        {width} × {height}
      </span>
    ) : (
      <span className="text-neutral-500">—</span>
    );

  return (
    <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/75 p-4">
      <div className="bg-zinc-900 border border-white/15 rounded-2xl max-w-md w-full shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h2 className="text-sm font-black tracking-widest uppercase text-white">画像書き出し</h2>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="p-1 rounded-lg hover:bg-white/10 text-neutral-400"
            aria-label="閉じる"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-xs text-neutral-300">
          {result && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3">
              <p className="font-bold text-emerald-300">✓ ダウンロードを開始しました</p>
              <p className="mt-1 break-all font-mono text-[11px] text-neutral-300">{result.fileName}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
                ダウンロードが始まらない、または保存ダイアログをキャンセルした場合は、下の「再ダウンロード」から保存し直せます（再生成は行いません）。
              </p>
            </div>
          )}
          {!result && (
            <>
          <p className="text-[10px] text-neutral-500 leading-relaxed">
            高解像（300–150 dpi 相当）と用紙サイズ（A3/A4）はクラウド API で高精細化してから書き出します（構図は維持）。用紙は対応比率の画像を用紙枠へ余白付きで配置します。プレビュー用は再生成しません。
          </p>
          <div className="space-y-2">
            {presets.map((p, i) => (
              <label
                key={p.id}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                  i === selectedIndex
                    ? 'border-emerald-500/50 bg-emerald-950/30'
                    : 'border-white/10 bg-black/30 hover:border-white/20'
                }`}
              >
                <input
                  type="radio"
                  name="exportPreset"
                  className="mt-0.5"
                  checked={i === selectedIndex}
                  onChange={() => setSelectedIndex(i)}
                  disabled={busy || sourceNaturalLoading}
                />
                <span>
                  <span className="text-white font-bold">{p.dpi} dpi</span>
                  <span className="block text-neutral-400 mt-0.5">{p.label}</span>
                  <span className="font-mono text-neutral-500">
                    {p.width} × {p.height} px
                  </span>
                </span>
              </label>
            ))}
            <p className="pt-1 text-[9px] font-black uppercase tracking-widest text-neutral-500">用紙サイズ（余白付き）</p>
            {PAPER_PRESETS.map((pp, j) => {
              const idx = PAPER_START + j;
              const dims = paperPixelDims(pp.paper, pp.dpi, paperOrientation);
              return (
                <label
                  key={pp.paper}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    idx === selectedIndex
                      ? 'border-emerald-500/50 bg-emerald-950/30'
                      : 'border-white/10 bg-black/30 hover:border-white/20'
                  }`}
                >
                  <input
                    type="radio"
                    name="exportPreset"
                    className="mt-0.5"
                    checked={idx === selectedIndex}
                    onChange={() => setSelectedIndex(idx)}
                    disabled={busy || sourceNaturalLoading}
                  />
                  <span>
                    <span className="text-white font-bold">{pp.paper}</span>
                    <span className="block text-neutral-400 mt-0.5">{pp.label}</span>
                    <span className="font-mono text-neutral-500">
                      {sourceNaturalLoading ? '読み込み中…' : `${dims.w} × ${dims.h} px`}
                    </span>
                  </span>
                </label>
              );
            })}
            <label
              key={EXPORT_PREVIEW_OPTION_ID}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                isPreview
                  ? 'border-emerald-500/50 bg-emerald-950/30'
                  : 'border-white/10 bg-black/30 hover:border-white/20'
              }`}
            >
              <input
                type="radio"
                name="exportPreset"
                className="mt-0.5"
                checked={isPreview}
                onChange={() => setSelectedIndex(PREVIEW_INDEX)}
                disabled={busy}
              />
              <span>
                <span className="text-white font-bold">{EXPORT_PREVIEW_LABEL}</span>
                <span className="block text-neutral-400 mt-0.5">{EXPORT_PREVIEW_DESCRIPTION}</span>
                <span className="font-mono text-neutral-500">
                  {sourceNaturalLoading
                    ? '読み込み中…'
                    : sourceNatural
                      ? `${sourceNatural.w} × ${sourceNatural.h} px`
                      : '—'}
                </span>
              </span>
            </label>
          </div>
          <div className="space-y-1">
            <p>
              <span className="text-neutral-500 font-bold">選択中の出力ピクセル</span> {pixelSummary}
            </p>
            <p>
              <span className="text-neutral-500 font-bold">縦横比</span> {aspectLabel} / {aspectDesc}
            </p>
          </div>
          <ul className="list-disc list-inside space-y-1 text-neutral-400 leading-relaxed">
            {footerLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {/* フリープランの高解像度DL月次制限（260624）。プレビュー保存は対象外。 */}
          {showHiResLimit &&
            (hiResLeft > 0 ? (
              <p className="text-[11px] font-bold text-neutral-400">
                高解像ダウンロード 残り {hiResLeft} / {FREE_PLAN_HIRES_DL_PER_MONTH} 回（今月・無料プラン。プレビュー保存は対象外）
              </p>
            ) : (
              <p className="text-[11px] font-bold leading-relaxed text-amber-300">
                今月の無料高解像ダウンロード（{FREE_PLAN_HIRES_DL_PER_MONTH}回）を使い切りました。これ以降の高解像書き出しには「フリープラン サンプル」透かしが入ります。アップグレードで透かしなしに。
              </p>
            ))}
            </>
          )}
          {error && <p className="text-red-400 break-words">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end px-4 py-3 border-t border-white/10 bg-black/20">
          {result ? (
            <>
              <button
                type="button"
                onClick={() => setResult(null)}
                className="px-4 py-2 rounded-lg bg-zinc-800 text-sm font-bold text-white"
              >
                別の設定で書き出す
              </button>
              <button
                type="button"
                onClick={() => triggerDownload(result)}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-bold text-white"
              >
                再ダウンロード
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-zinc-800 text-sm font-bold text-white disabled:opacity-40"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={busy || !sourceImageDataUrl || sourceNaturalLoading}
                onClick={() => void runExport()}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-bold text-white disabled:opacity-40 flex items-center gap-2"
              >
                {busy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    処理中…
                  </>
                ) : (
                  'PNG でダウンロード'
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
