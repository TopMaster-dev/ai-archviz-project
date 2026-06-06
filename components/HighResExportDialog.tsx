import React, { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { geminiAuthHeaders } from '../lib/byok.js';
import { downscaleDataUrlIfNeeded } from '../utils/downscaleDataUrl.js';
import {
  describePixelAspect,
  EXPORT_GEMINI_IMAGE_SIZE,
  EXPORT_PRESETS_16_9,
  EXPORT_PREVIEW_DESCRIPTION,
  EXPORT_PREVIEW_LABEL,
  EXPORT_PREVIEW_OPTION_ID,
  EXPORT_RENDER_INPUT_MAX_SIDE,
  exportPresetFooterLines,
  exportPreviewFooterLines,
  PREVIEW_ASPECT_RATIO,
  type ExportPreset16x9,
} from '../utils/printExportSpec.js';
import { resizeDataUrlToSize } from '../utils/resizeDataUrl.js';

const RENDER_PROMPT =
  'フォトリアルな建築写真として仕上げてください。光の反射と質感を強調してください。';

const PRESET_COUNT = EXPORT_PRESETS_16_9.length;
const PREVIEW_INDEX = PRESET_COUNT;

type Props = {
  open: boolean;
  onClose: () => void;
  sourceImageDataUrl: string | null;
};

export function HighResExportDialog({ open, onClose, sourceImageDataUrl }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(PREVIEW_INDEX);
  const [sourceNatural, setSourceNatural] = useState<{ w: number; h: number } | null>(null);
  const [sourceNaturalLoading, setSourceNaturalLoading] = useState(false);

  const isPreview = selectedIndex === PREVIEW_INDEX;
  const dpiPreset: ExportPreset16x9 | null = !isPreview
    ? (EXPORT_PRESETS_16_9[selectedIndex] ?? EXPORT_PRESETS_16_9[0]!)
    : null;

  useEffect(() => {
    if (open) {
      setSelectedIndex(PREVIEW_INDEX);
    }
  }, [open]);

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

  const width = isPreview ? (sourceNatural?.w ?? 0) : dpiPreset!.width;
  const height = isPreview ? (sourceNatural?.h ?? 0) : dpiPreset!.height;
  const aspectLabel = '16 : 9';
  const aspectDesc = width > 0 && height > 0 ? describePixelAspect(width, height) : '—';

  const footerLines = isPreview ? exportPreviewFooterLines() : exportPresetFooterLines(dpiPreset!);

  const runExport = async () => {
    if (!sourceImageDataUrl) {
      setError('書き出す画像がありません。');
      return;
    }
    setError(null);

    if (isPreview) {
      try {
        const a = document.createElement('a');
        a.href = sourceImageDataUrl;
        const wh =
          sourceNatural && sourceNatural.w > 0 && sourceNatural.h > 0
            ? `${sourceNatural.w}x${sourceNatural.h}`
            : 'image';
        a.download =
          wh === 'image' ? 'archviz_preview.png' : `archviz_preview_${wh}.png`;
        a.click();
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'エラー');
      }
      return;
    }

    setBusy(true);
    try {
      const inputImage = await downscaleDataUrlIfNeeded(
        sourceImageDataUrl,
        EXPORT_RENDER_INPUT_MAX_SIDE
      );
      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({
          image: inputImage,
          prompt: RENDER_PROMPT,
          aspectRatio: PREVIEW_ASPECT_RATIO,
          imageSize: EXPORT_GEMINI_IMAGE_SIZE,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '書き出しに失敗しました');
      let url = data.url as string;
      const p = dpiPreset!;
      url = await resizeDataUrlToSize(url, p.width, p.height);
      const a = document.createElement('a');
      a.href = url;
      a.download = `archviz_print_${p.dpi}dpi_${p.width}x${p.height}.png`;
      a.click();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'エラー');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const pixelSummary =
    isPreview && sourceNaturalLoading ? (
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
          <p className="text-[10px] text-neutral-500 leading-relaxed">
            高解像（300–150 dpi 相当）はクラウド API で再レンダ後に目標ピクセルへ合わせます。プレビュー用は再生成しません。
          </p>
          <div className="space-y-2">
            {EXPORT_PRESETS_16_9.map((p, i) => (
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
                  disabled={busy}
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
          {error && <p className="text-red-400 break-words">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end px-4 py-3 border-t border-white/10 bg-black/20">
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
            disabled={busy || !sourceImageDataUrl || (isPreview && sourceNaturalLoading)}
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
        </div>
      </div>
    </div>
  );
}
