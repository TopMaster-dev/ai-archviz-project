import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import { recordAiFeedback } from '../lib/db/feedback.js';
import { downscaleDataUrlIfNeeded } from '../utils/downscaleDataUrl.js';
import { ensureDataUrl } from '../lib/db/aiRenderStorage.js';
import {
  EXPORT_GEMINI_IMAGE_SIZE,
  EXPORT_RENDER_INPUT_MAX_SIDE,
  exportPresetsForRatio,
  type ExportPreset16x9,
} from '../utils/printExportSpec.js';
import { pickClosestCropRatio } from '../utils/cropToAspect.js';
import { aspectLabelForKey, ratioValueForKey } from '../utils/renderAspect.js';
import { fitDataUrlToSize } from '../utils/fitDataUrl.js';
import { matchOverallColorToReference } from '../utils/colorMatch.js';
import { sharpenDataUrl, unsharpParamsForUpscale } from '../utils/unsharpMask.js';
import {
  ENABLE_FREE_PLAN_HIRES_DL_LIMIT,
  FREE_PLAN_HIRES_DL_PER_MONTH,
  hiResRemaining,
  incrementHiResDownloadCount,
  isOverHiResLimit,
} from '../utils/freePlanHiResLimit.js';
import { applyFreePlanOutputLimits } from '../utils/freePlanImage.js';
import { buildPreviewFileName, buildHiResFileName } from '../utils/exportFileName.js';

type Props = {
  open: boolean;
  onClose: () => void;
  sourceImageDataUrl: string | null;
  /** ダウンロード（書き出し）成功時。暗黙的フィードバック（採用＝good）の記録に使う（管理表 row 210/216）。 */
  onExported?: () => void;
  /** 高解像度DL月次制限の判定用（260624）。プラン種別とログインユーザーID。 */
  plan?: string | null;
  userId?: string | null;
  /** 書き出しファイル名に使うプロジェクト名（260625）。 */
  projectName?: string | null;
};

/** 書き出し完了後に保持するダウンロード対象（再ダウンロード用・260625 #4）。 */
type ExportResult = { url: string; fileName: string; kind: 'preview' | 'hiRes' };

/*
 * 書き出しの選択肢（260731 クライアント指摘「白かったカウンターが木目に変わった」の対応で3択へ）。
 *
 * 従来は 'hires'（AI精細化）と 'preview'（等倍そのまま）の2択で、しかも既定が 'hires' だった。
 * つまり「印刷用の大きさが欲しい」だけでも必ずAIが画像全体を描き直す経路しか無く、
 * 描き直しである以上、白い天板に木目が入るような改変は原理的に避けられなかった。
 *
 * そこで「大きさは欲しいが内容は1ピクセルも変えたくない」場合の逃げ道として
 * 'hires-exact'（決定論の拡大のみ・AIを通さない）を追加し、これを既定にする。
 * AI精細化は、ぼけた画像を積極的に描き起こしたいときだけ選ぶオプトインへ降格する。
 */
type ExportMode = 'hires-exact' | 'hires' | 'preview';

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
  // 既定は「高解像度（AIなし）」。画面に見えているものを1ピクセルも変えずに大きくする、が既定として安全
  // （260731・AI精細化を既定にしていたため、白い天板が木目に変わる改変が既定経路で起きていた）。
  const [mode, setMode] = useState<ExportMode>('hires-exact');
  const [sourceNatural, setSourceNatural] = useState<{ w: number; h: number } | null>(null);
  const [sourceNaturalLoading, setSourceNaturalLoading] = useState(false);
  // #4: 書き出し完了後のダウンロード対象を保持し、保存をキャンセルしても再ダウンロードできるようにする。
  const [result, setResult] = useState<ExportResult | null>(null);
  /*
   * 書き出し結果の評価（260731 クライアント要望）。
   * AIが描き直したものだけを評価対象にするため、その書き出しでAIを使ったかを覚えておく
   * （result.kind は 'hiRes' でも、AIなし拡大の場合があるため kind だけでは判別できない）。
   */
  const [exportUsedAi, setExportUsedAi] = useState(false);
  const [verdict, setVerdict] = useState<'good' | 'bad' | null>(null);
  const sendExportFeedback = (v: 'good' | 'bad') => {
    setVerdict(v);
    // 記録は best-effort（失敗しても書き出しの成功体験を壊さない）。
    void recordAiFeedback({
      verdict: v,
      feature: 'export',
      promptContext: { source: 'hires-export', mode: 'ai-enhance' },
    }).catch(() => {
      /* 未ログイン・未構成では記録しない（UI は成功のまま） */
    });
  };

  // 書き出し比率は「元画像の実寸から最も近い対応比率」で決める（読込前は 16:9）。
  const exportRatioKey = sourceNatural
    ? pickClosestCropRatio(sourceNatural.w, sourceNatural.h).key
    : '16:9';
  // 最高解像度プリセット（一択）。exportPresetsForRatio は dpi 降順（先頭=300dpi=最高解像度）。
  const hiResPreset: ExportPreset16x9 = useMemo(
    () => exportPresetsForRatio(ratioValueForKey(exportRatioKey))[0]!,
    [exportRatioKey],
  );

  const isPreview = mode === 'preview';

  /*
   * 実効解像度の表示（260801 クライアント指摘への対応）。
   *
   * 「300dpi」はあくまで用紙サイズから逆算した出力の画素数であって、
   * 元画像がそれだけの情報量を持っているという意味ではない。
   * 元が長辺2688pxなら、A3・300dpi（長辺4961px）へ拡大しても
   * 実際の情報量は約163dpi相当にとどまる。ここを黙って「300dpi」とだけ表示するのは不正確なので、
   * 「元が何pxで、何倍に拡大され、実効何dpi相当か」を必ず出す。
   * ※AI精細化を選んだ場合も、生成は4K（長辺3840px）なので最後に1.29倍の拡大が入る。
   *   どちらの経路でも“真の300dpi”にはならない、という事実を隠さない。
   */
  const sourceLongEdge = sourceNatural ? Math.max(sourceNatural.w, sourceNatural.h) : 0;
  const a3LongEdgeMm = 420 / 25.4;
  const effectiveDpi = sourceLongEdge ? Math.round(sourceLongEdge / a3LongEdgeMm) : 0;
  const upscaleFactor = sourceLongEdge ? hiResPreset.width / sourceLongEdge : 0;

  useEffect(() => {
    if (open) {
      setMode('hires-exact');
      setResult(null);
      setError(null);
      setVerdict(null);
      setExportUsedAi(false);
    }
  }, [open]);

  // モード変更時は前回のダウンロード結果をクリア（別設定の古い結果を再ダウンロードさせない）。
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [mode]);

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

  const width = isPreview ? (sourceNatural?.w ?? 0) : hiResPreset.width;
  const height = isPreview ? (sourceNatural?.h ?? 0) : hiResPreset.height;
  const contentAspectLabel = aspectLabelForKey(exportRatioKey);

  // #4: 保持済みの result を使ってダウンロードをトリガー（再生成・API 呼び出し・カウント消費なし）。
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
    const src = await ensureDataUrl(sourceImageDataUrl);

    if (isPreview) {
      // プレビューは再生成せず、いまの画像をそのまま PNG 保存（即時・色/内容は画面と完全一致）。
      const previewResult: ExportResult = {
        url: src,
        fileName: buildPreviewFileName(projectName),
        kind: 'preview',
      };
      setResult(previewResult);
      triggerDownload(previewResult);
      onExported?.();
      return;
    }

    if (mode === 'hires-exact') {
      /*
       * 【高解像度（AIなし）】AIを一切通さず、拡大と鮮鋭化だけで印刷サイズへ持ち上げる。
       *
       * 補間で拡大するだけでは輪郭が甘くなる（＝クライアントご指摘の「ボヤけた引き伸ばし」）。
       * そこで拡大後にアンシャープマスクを掛け、輪郭のコントラストを回復させる。
       * これは元の画素から計算する決定論の処理なので、
       * 「元画像に無いものは生まれない」という保証を保ったまま見た目の甘さだけを改善できる。
       * AIを呼ばないので課金もフリープランの回数消費も発生しない。
       */
      setBusy(true);
      try {
        const p = hiResPreset;
        const fileName = buildHiResFileName(projectName, { dpi: p.dpi, width: p.width, height: p.height });
        const scaled = await fitDataUrlToSize(src, p.width, p.height, 'cover');
        // 拡大率に応じた強さで鮮鋭化する（等倍・縮小のときは何もしない）。
        const factor = sourceNatural ? p.width / Math.max(1, sourceNatural.w) : 1;
        const sharpenOpts = unsharpParamsForUpscale(factor);
        const url = sharpenOpts ? await sharpenDataUrl(scaled, sharpenOpts) : scaled;
        const exactResult: ExportResult = { url, fileName, kind: 'hiRes' };
        setExportUsedAi(false);
        setResult(exactResult);
        triggerDownload(exactResult);
        onExported?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'エラー');
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const p = hiResPreset; // 最高解像度（一択）
      const fileName = buildHiResFileName(projectName, { dpi: p.dpi, width: p.width, height: p.height });
      // 【高解像度画像＝AI高精細化】構図・色を変えない精細化専用経路（enhanceDetail・温度0.12・buildEnhanceDetailPrompt）。
      // 初回レンダ用 proVisualizerPrompt の再ライティングを避け、色/形を保ったまま鮮明に高解像度化する（260724）。
      const inputImage = await downscaleDataUrlIfNeeded(src, EXPORT_RENDER_INPUT_MAX_SIDE);
      const res = await fetch('/api/ai-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({
          baseImage: inputImage,
          enhanceDetail: true,
          aspectRatio: exportRatioKey,
          imageSize: EXPORT_GEMINI_IMAGE_SIZE,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '書き出しに失敗しました');
      void recordAiUsage({ feature: 'export', usage: data.usage, model: data.model, imageCount: 1 });
      let g = data.url as string;
      // 全体の色味をプレビューへ合わせる（AI精細化のわずかな色被り/WBズレを決定論で補正・260725 クライアント要望）。
      g = await matchOverallColorToReference(g, src);
      let url = await fitDataUrlToSize(g, p.width, p.height, 'cover');
      // フリープラン: 今月の無償高解像度DL超過時は透かし合成（AI生成のときのみ・260624）。
      if (isOverHiResLimit(userId, isFreePlan)) {
        url = await applyFreePlanOutputLimits(url, Number.MAX_SAFE_INTEGER);
      }
      incrementHiResDownloadCount(userId, isFreePlan); // AI生成1回につき1回だけ消費（再DLは非消費）。
      const exportResult: ExportResult = { url, fileName, kind: 'hiRes' };
      setExportUsedAi(true);
      setVerdict(null);
      setResult(exportResult);
      triggerDownload(exportResult);
      onExported?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'エラー');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const pixelSummary = isPreview && sourceNaturalLoading ? (
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
      <div className="bg-zinc-900 border border-white/15 rounded-2xl max-w-md w-full shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
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
        <div className="p-4 space-y-3 text-xs text-neutral-300 flex-1 min-h-0 overflow-y-auto scroll-dark">
          {result && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3">
              <p className="font-bold text-emerald-300">✓ ダウンロードを開始しました</p>
              <p className="mt-1 break-all font-mono text-[11px] text-neutral-300">{result.fileName}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
                ダウンロードが始まらない、または保存ダイアログをキャンセルした場合は、下の「再ダウンロード」から保存し直せます（再生成は行いません）。
              </p>
              {/*
                書き出し結果の評価（260731 クライアント要望）。
                AIが描き直した結果にだけ意味があるので、AIを通していない書き出しには出さない
                （「AIなし」に良い/悪いを付けても学習材料にならない）。
              */}
              {result.kind === 'hiRes' && exportUsedAi && (
                <div className="mt-3 border-t border-white/10 pt-2">
                  <p className="text-[11px] text-neutral-400">この書き出し結果はいかがでしたか？</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={verdict !== null}
                      onClick={() => sendExportFeedback('good')}
                      className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-bold transition ${
                        verdict === 'good'
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                          : 'border-white/15 text-neutral-300 hover:bg-white/10 disabled:opacity-40'
                      }`}
                    >
                      <ThumbsUp className="h-3.5 w-3.5" aria-hidden /> いいね
                    </button>
                    <button
                      type="button"
                      disabled={verdict !== null}
                      onClick={() => sendExportFeedback('bad')}
                      className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-bold transition ${
                        verdict === 'bad'
                          ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                          : 'border-white/15 text-neutral-300 hover:bg-white/10 disabled:opacity-40'
                      }`}
                    >
                      <ThumbsDown className="h-3.5 w-3.5" aria-hidden /> わるいね
                    </button>
                    {verdict && <span className="text-[11px] text-neutral-500">ありがとうございます。</span>}
                  </div>
                </div>
              )}
            </div>
          )}
          {!result && (
            <>
              <p className="text-[10px] text-neutral-500 leading-relaxed">
                書き出し方法を選んでください。内容を変えたくない場合は「高解像度（AIなし）」を選んでください。
                「AI精細化」はAIが画像を描き直すため、ぼけは改善しやすい一方で、細部（素材の柄など）が変わることがあります。
              </p>
              <div className="space-y-2">
                {/* 高解像度（AIなし・忠実拡大）＝既定。260731: 内容を1ピクセルも変えない逃げ道。 */}
                <label
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    mode === 'hires-exact'
                      ? 'border-emerald-500/50 bg-emerald-950/30'
                      : 'border-white/10 bg-black/30 hover:border-white/20'
                  }`}
                >
                  <input
                    type="radio"
                    name="exportMode"
                    className="mt-0.5"
                    checked={mode === 'hires-exact'}
                    onChange={() => setMode('hires-exact')}
                    disabled={busy || sourceNaturalLoading}
                  />
                  <span>
                    <span className="text-white font-bold">高解像度（AIなし）</span>
                    <span className="block text-neutral-400 mt-0.5">
                      拡大＋輪郭の鮮鋭化のみ。描き直さないので絵柄・色は絶対に変わりません（費用なし・即時）。
                      情報量は元画像のままなので、AI精細化よりは softer になります
                    </span>
                    <span className="font-mono text-neutral-500">
                      {hiResPreset.width} × {hiResPreset.height} px
                      {upscaleFactor > 1 ? `（元画像を約 ${upscaleFactor.toFixed(1)} 倍に拡大）` : ''}
                    </span>
                  </span>
                </label>
                {/* 高解像度＋AI精細化（オプトイン）。 */}
                <label
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    mode === 'hires'
                      ? 'border-emerald-500/50 bg-emerald-950/30'
                      : 'border-white/10 bg-black/30 hover:border-white/20'
                  }`}
                >
                  <input
                    type="radio"
                    name="exportMode"
                    className="mt-0.5"
                    checked={mode === 'hires'}
                    onChange={() => setMode('hires')}
                    disabled={busy || sourceNaturalLoading}
                  />
                  <span>
                    <span className="text-white font-bold">高解像度＋AI精細化</span>
                    <span className="block text-neutral-400 mt-0.5">
                      AIが描き直してぼけを改善します。構図・色の維持を優先しますが、細部が変わる場合があります
                    </span>
                    <span className="font-mono text-neutral-500">
                      {hiResPreset.width} × {hiResPreset.height} px
                    </span>
                  </span>
                </label>
                {/* プレビュー画像（そのまま保存・再生成なし） */}
                <label
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    isPreview
                      ? 'border-emerald-500/50 bg-emerald-950/30'
                      : 'border-white/10 bg-black/30 hover:border-white/20'
                  }`}
                >
                  <input
                    type="radio"
                    name="exportMode"
                    className="mt-0.5"
                    checked={isPreview}
                    onChange={() => setMode('preview')}
                    disabled={busy}
                  />
                  <span>
                    <span className="text-white font-bold">プレビュー画像</span>
                    <span className="block text-neutral-400 mt-0.5">いま画面の画像をそのまま保存（再生成なし・即時）</span>
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
                  <span className="text-neutral-500 font-bold">縦横比</span> {contentAspectLabel}
                </p>
                {/*
                  「300dpi」は用紙サイズから逆算した出力画素数であって、元画像の情報量ではない。
                  どちらの経路でも最後に拡大が入るため、真の300dpiにはならない。ここを隠さず出す。
                */}
                {!isPreview && sourceLongEdge > 0 && (
                  <p>
                    <span className="text-neutral-500 font-bold">元画像</span> {sourceNatural?.w} × {sourceNatural?.h} px
                    <span className="ml-2 text-neutral-500">
                      （実効 約 {effectiveDpi} dpi 相当。表示の {hiResPreset.dpi}dpi は用紙サイズから逆算した出力画素数です）
                    </span>
                  </p>
                )}
              </div>
              <ul className="list-disc list-inside space-y-1 text-neutral-400 leading-relaxed">
                <li>アプリ内の表示は低解像のままです。印刷にはダウンロード画像を使用してください。</li>
                {mode === 'hires' && (
                  <li>
                    AI精細化は画像を描き直す処理です。ぼけの改善が見込める一方、素材の柄など細部が変わることがあります。
                    画面のとおりに出力したい場合は「高解像度（AIなし）」をお選びください。
                  </li>
                )}
                <li>最終出力は印刷所・DTP の指定に合わせてください。</li>
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
        <div className="flex gap-2 justify-end px-4 py-3 border-t border-white/10 bg-black/20 shrink-0">
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
