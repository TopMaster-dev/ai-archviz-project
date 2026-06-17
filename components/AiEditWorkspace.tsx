import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  ImagePlus,
  Loader2,
  Plus,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import type { AiEditObjectReference, AiEditVersion, NormalizedRect } from '../types.js';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiFeedback, getRecentGoodHints } from '../lib/db/feedback.js';
import { useOptionalProjectSession } from '../lib/project/projectSessionContext.js';
import { maybeApplyFreePlanOutputLimits } from '../utils/freePlanImage.js';
import { creditBlockMessage } from '../utils/freePlanCredits.js';
import { aiEditObjectUiColors } from '../utils/aiEditObjectPalette.js';
import { downscaleDataUrlIfNeeded } from '../utils/downscaleDataUrl.js';
import { pickClosestAspectRatio } from '../utils/pickClosestAspectRatio.js';
import { resizeDataUrlToSize } from '../utils/resizeDataUrl.js';
import { AgentChatPanel } from './AgentChatPanel.js';
import { HighResExportDialog } from './HighResExportDialog.js';
import { ModeToggleBar } from './ModeToggleBar.js';

function normalizeImageDataUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return null;
  return s;
}

function getContainedRect(
  containerW: number,
  containerH: number,
  imgNaturalW: number,
  imgNaturalH: number
) {
  if (imgNaturalW <= 0 || imgNaturalH <= 0) {
    return { ox: 0, oy: 0, dw: containerW, dh: containerH };
  }
  const ir = imgNaturalW / imgNaturalH;
  const cr = containerW / containerH;
  let dw: number;
  let dh: number;
  let ox: number;
  let oy: number;
  if (ir > cr) {
    dw = containerW;
    dh = containerW / ir;
    ox = 0;
    oy = (containerH - dh) / 2;
  } else {
    dh = containerH;
    dw = containerH * ir;
    ox = (containerW - dw) / 2;
    oy = 0;
  }
  return { ox, oy, dw, dh };
}

function clientToNormalized(
  clientX: number,
  clientY: number,
  el: HTMLElement,
  naturalW: number,
  naturalH: number
): { nx: number; ny: number } | null {
  const r = el.getBoundingClientRect();
  const { ox, oy, dw, dh } = getContainedRect(r.width, r.height, naturalW, naturalH);
  const lx = clientX - r.left - ox;
  const ly = clientY - r.top - oy;
  if (lx < 0 || ly < 0 || lx > dw || ly > dh) return null;
  return { nx: lx / dw, ny: ly / dh };
}

function loadImageNaturalSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    img.src = dataUrl;
  });
}

type Props = {
  isOpen: boolean;
  viewMode: 'sketch' | '3D';
  canSwitchTo3D: boolean;
  onSwitchToSketch: () => void;
  onSwitchTo3D: () => void;
  onSwitchToAiEdit: () => void;
  versions: AiEditVersion[];
  activeVersionId: string | null;
  activeVersion: AiEditVersion | null;
  onSelectVersion: (id: string) => void;
  draftStyleRefDataUrl: string | null;
  onStyleRefChange: (dataUrl: string | null) => void;
  draftStyleMemo: string;
  onStyleMemoChange: (s: string) => void;
  draftObjects: AiEditObjectReference[];
  onAddObject: () => void;
  onUpdateObjectImage: (id: string, dataUrl: string | null) => void;
  onRemoveObject: (id: string) => void;
  onUpdateObjectMemo: (id: string, memo: string) => void;
  activeObjectId: string | null;
  onActiveObjectChange: (id: string | null) => void;
  placementEditIndex: number | null;
  onSetAppendPlacementMode: () => void;
  onSetReplacePlacementMode: (objectId: string, index: number) => void;
  onCommitPlacementRect: (objectId: string, rect: NormalizedRect) => void;
  onRemovePlacementAt: (objectId: string, index: number) => void;
  estimatePanel?: React.ReactNode;
  onEditSuccess: (params: {
    parentId: string;
    baseImageDataUrl: string;
    outputImageDataUrl: string;
    styleRefDataUrl: string | null;
    styleMemo: string;
    objects: AiEditObjectReference[];
  }) => void;
  /** 写真AI編集専用モード（2a）。2D/3D タブを隠し、空状態を写真アップロードにする。 */
  photoOnly?: boolean;
  /** 写真専用モードでホームへ戻る（オーバーレイが画面右上の「ホームに戻る」を覆うため自前で出す）。 */
  onExitToHome?: () => void;
  /** ホームへ戻る処理（離脱時オートセーブ）の実行中。ボタンを無効化＆「保存中…」表示にする。 */
  exitToHomeBusy?: boolean;
  /** 写真専用の空状態で、アップロードした写真をベース画像(v0)として登録する。 */
  onUploadBaseImage?: (dataUrl: string) => void;
};

export function AiEditWorkspace({
  isOpen,
  viewMode,
  canSwitchTo3D,
  onSwitchToSketch,
  onSwitchTo3D,
  onSwitchToAiEdit,
  versions,
  activeVersionId,
  activeVersion,
  onSelectVersion,
  draftStyleRefDataUrl,
  onStyleRefChange,
  draftStyleMemo,
  onStyleMemoChange,
  draftObjects,
  onAddObject,
  onUpdateObjectImage,
  onRemoveObject,
  onUpdateObjectMemo,
  activeObjectId,
  onActiveObjectChange,
  placementEditIndex,
  onSetAppendPlacementMode,
  onSetReplacePlacementMode,
  onCommitPlacementRect,
  onRemovePlacementAt,
  estimatePanel,
  onEditSuccess,
  photoOnly = false,
  onExitToHome,
  exitToHomeBusy = false,
  onUploadBaseImage,
}: Props) {
  const [highResExportOpen, setHighResExportOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);
  const [compareSlider, setCompareSlider] = useState(50);
  const [objectImageTargetId, setObjectImageTargetId] = useState<string | null>(null);
  const [isSituationCardVisible, setIsSituationCardVisible] = useState(false);

  const styleInputRef = useRef<HTMLInputElement>(null);
  const objectInputRef = useRef<HTMLInputElement>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [dragStart, setDragStart] = useState<{ nx: number; ny: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ nx: number; ny: number } | null>(null);
  const [imgLayout, setImgLayout] = useState({ ox: 0, oy: 0, dw: 1, dh: 1 });

  // フリープラン出力制限（縮小＋透かし・row 51/52）用にプランを参照（ゲスト=null=制限なし）。
  const projectSession = useOptionalProjectSession();
  const isFreePlan = projectSession?.plan === 'free';

  const baseDisplayUrl = activeVersion?.outputImageDataUrl ?? null;

  // AI生成の良し悪し評価（good/bad）。記録は ai_feedback_events へベストエフォート（管理表 row 209/215）。
  const [feedbackByVersion, setFeedbackByVersion] = useState<Record<string, 'good' | 'bad'>>({});
  const feedbackRef = useRef<Record<string, 'good' | 'bad'>>({});
  const submitFeedback = useCallback(
    async (versionId: string, verdict: 'good' | 'bad') => {
      if (!versionId || feedbackRef.current[versionId] === verdict) return;
      feedbackRef.current = { ...feedbackRef.current, [versionId]: verdict };
      setFeedbackByVersion({ ...feedbackRef.current });
      // in-context反映（row 211/219）用に、その版のスタイル傾向（styleMemo）を併せて記録する。
      const v = versions.find((x) => x.id === versionId);
      const styleMemo = v?.styleMemo?.trim() || undefined;
      try {
        await recordAiFeedback({
          verdict,
          imageRef: versionId,
          feature: 'ai_design',
          promptContext: styleMemo ? { styleMemo } : null,
        });
      } catch (e) {
        // 記録失敗はUI操作を妨げない（ベストエフォート）。選択状態は維持する。
        console.warn('[ai feedback] 評価の記録に失敗しました', e);
      }
    },
    [versions],
  );

  // 初回ポップアップ:「評価すると精度が上がる」旨を一度だけ案内（localStorage で既読管理）。
  const [showFeedbackTip, setShowFeedbackTip] = useState(false);
  useEffect(() => {
    if (!baseDisplayUrl) return;
    try {
      if (!localStorage.getItem('arise.aiFeedbackTip.seen')) setShowFeedbackTip(true);
    } catch {
      setShowFeedbackTip(true);
    }
  }, [baseDisplayUrl]);
  const dismissFeedbackTip = useCallback(() => {
    setShowFeedbackTip(false);
    try {
      localStorage.setItem('arise.aiFeedbackTip.seen', '1');
    } catch {
      // localStorage 不可でも閉じる
    }
  }, []);

  const activeObjectIndex = draftObjects.findIndex((o) => o.id === activeObjectId);
  const dragPreviewColors =
    activeObjectIndex >= 0
      ? aiEditObjectUiColors(activeObjectIndex)
      : { border: 'rgb(255 255 255)', fill: 'rgba(255,255,255,0.08)' };

  const measureLayout = useCallback(() => {
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!wrap || !img?.naturalWidth) return;
    const wr = wrap.getBoundingClientRect();
    const { ox, oy, dw, dh } = getContainedRect(
      wr.width,
      wr.height,
      img.naturalWidth,
      img.naturalHeight
    );
    setImgLayout({ ox, oy, dw, dh });
  }, []);

  useLayoutEffect(() => {
    measureLayout();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => measureLayout());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measureLayout, baseDisplayUrl, isOpen]);

  useEffect(() => {
    if (isOpen && baseDisplayUrl) {
      setCompareA(baseDisplayUrl);
      setCompareB(baseDisplayUrl);
    }
  }, [isOpen, activeVersionId, baseDisplayUrl]);

  useEffect(() => {
    if (!isOpen) return;
    const hasSituationDraft =
      !!normalizeImageDataUrl(draftStyleRefDataUrl) || draftStyleMemo.trim().length > 0;
    // Keep the card visible once shown; only trash action hides it.
    setIsSituationCardVisible((prev) => prev || hasSituationDraft);
  }, [isOpen, draftStyleRefDataUrl, draftStyleMemo]);

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    });

  const onPickStyleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    try {
      const url = await readFileAsDataUrl(f);
      onStyleRefChange(url);
    } catch {
      /* ignore */
    }
  };

  const onPickObjectFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    if (!objectImageTargetId) return;
    try {
      const url = await readFileAsDataUrl(f);
      onUpdateObjectImage(objectImageTargetId, url);
      setObjectImageTargetId(null);
    } catch {
      /* ignore */
    }
  };

  // 写真専用モード（2a）: アップロード写真をベース画像(v0)として登録。保存サイズを抑えるため縮小。
  const onPickBaseFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    try {
      const url = await readFileAsDataUrl(f);
      const sized = await downscaleDataUrlIfNeeded(url, 1536);
      onUploadBaseImage?.(sized);
    } catch {
      /* ignore */
    }
  };

  // 上部左のバー: 通常は 2D/3D/AI のモード切替、写真専用モードでは「ホームに戻る」ボタン（2a）。
  const renderModeBarOrHome = () =>
    photoOnly ? (
      <button
        type="button"
        onClick={onExitToHome}
        disabled={exitToHomeBusy}
        title="ホームに戻る（プロジェクト一覧）"
        className="glass pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-2xl border border-white/10 bg-black/40 px-4 py-2.5 text-[11px] font-black uppercase tracking-widest text-white/80 shadow-xl backdrop-blur-md transition hover:text-white disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:text-white/80"
      >
        {exitToHomeBusy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            保存中…
          </>
        ) : (
          '← ホームに戻る'
        )}
      </button>
    ) : (
      <ModeToggleBar
        activeMode="ai"
        onSwitchToSketch={onSwitchToSketch}
        onSwitchTo3D={onSwitchTo3D}
        onSwitchToAi={onSwitchToAiEdit}
        canSwitchTo3D={canSwitchTo3D}
        className="shrink-0"
      />
    );

  const styleImageDataUrl = normalizeImageDataUrl(draftStyleRefDataUrl);
  const hasSituationInput =
    isSituationCardVisible && (!!styleImageDataUrl || draftStyleMemo.trim().length > 0);
  const emptySituationCard =
    isSituationCardVisible && !styleImageDataUrl && draftStyleMemo.trim().length === 0;
  const areaEmptyCount = draftObjects.filter((o) => {
    const image = normalizeImageDataUrl(o.imageDataUrl);
    return !image && o.memo.trim().length === 0;
  }).length;
  const emptyCardCount = (emptySituationCard ? 1 : 0) + areaEmptyCount;
  const areaEditItems = draftObjects.filter(
    (o) =>
      !!normalizeImageDataUrl(o.imageDataUrl) ||
      o.memo.trim().length > 0 ||
      o.placementMemos.some((m) => m.trim().length > 0)
  );
  const hasAreaEditInput = areaEditItems.length > 0;
  const areaPlacementCount = areaEditItems.reduce((sum, o) => sum + o.placements.length, 0);
  const hasAnyInput = hasSituationInput || hasAreaEditInput;
  const requiresAreaPlacement = hasAreaEditInput && areaPlacementCount === 0;

  const runEdit = useCallback(async () => {
    if (!activeVersion) return;
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const baseScaled = await downscaleDataUrlIfNeeded(activeVersion.outputImageDataUrl);
      const { w: baseW, h: baseH } = await loadImageNaturalSize(baseScaled);
      const aspectRatio = pickClosestAspectRatio(baseW, baseH);
      const imageSize = '2K';

      const styleScaled = styleImageDataUrl ? await downscaleDataUrlIfNeeded(styleImageDataUrl) : null;
      const objectsScaled = await Promise.all(
        draftObjects.map(async (o) => ({
          ...o,
          imageDataUrl: normalizeImageDataUrl(o.imageDataUrl)
            ? await downscaleDataUrlIfNeeded(normalizeImageDataUrl(o.imageDataUrl) as string)
            : null,
        }))
      );

      // in-context反映（row 211/219）: 過去に高評価した傾向を取得し、生成プロンプトへ参考添付（ベストエフォート）。
      const learnedHints = await getRecentGoodHints().catch(() => [] as string[]);
      const body: Record<string, unknown> = {
        baseImage: baseScaled,
        styleImage: styleScaled,
        objects: objectsScaled,
        aspectRatio,
        imageSize,
        learnedHints,
      };
      if (isSituationCardVisible && draftStyleMemo.trim()) {
        body.styleMemo = draftStyleMemo.trim();
      }

      const res = await fetch('/api/ai-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '編集に失敗しました');

      let outUrl = data.url as string;
      outUrl = await resizeDataUrlToSize(outUrl, baseW, baseH);
      // フリープラン出力制限（縮小＋透かし・row 51/52）。テストマーケ中は既定で無効。
      outUrl = await maybeApplyFreePlanOutputLimits(outUrl, isFreePlan);

      const prevOut = activeVersion.outputImageDataUrl;
      setCompareA(prevOut);
      setCompareB(outUrl);
      setCompareSlider(50);

      // 暗黙的フィードバック（管理表 row 210/216・クライアント6/3の例）: いま編集している版に既存の子があれば
      // ＝「一つ前に戻って再生成した」とみなし、直前の生成結果（最新の既存子）を暗黙の bad として記録する。
      // prompt_context で明示評価と区別する。ベストエフォート（失敗してもUIは妨げない）。
      const priorChildren = versions.filter((v) => v.parentId === activeVersion.id);
      if (priorChildren.length > 0) {
        const abandoned = priorChildren.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        void recordAiFeedback({
          verdict: 'bad',
          imageRef: abandoned.id,
          feature: 'ai_design',
          promptContext: { implicit: true, signal: 'regenerate' },
        }).catch((e) => console.warn('[ai feedback] 暗黙的bad評価の記録に失敗', e));
      }

      onEditSuccess({
        parentId: activeVersion.id,
        baseImageDataUrl: activeVersion.outputImageDataUrl,
        outputImageDataUrl: outUrl,
        styleRefDataUrl: isSituationCardVisible ? styleImageDataUrl : null,
        styleMemo: isSituationCardVisible ? draftStyleMemo.trim() : '',
        objects: draftObjects.map((o) => ({
          ...o,
          placements: o.placements.map((p) => ({ ...p })),
        })),
      });
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'エラー');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    activeVersion,
    versions,
    styleImageDataUrl,
    draftStyleMemo,
    isSituationCardVisible,
    draftObjects,
    onEditSuccess,
    isFreePlan,
  ]);

  const handleClickExecute = () => {
    if (!activeVersion || isSubmitting) return;
    if (emptyCardCount > 0) {
      setSubmitError(`未入力カードがあります（未入力${emptyCardCount}件）`);
      return;
    }
    if (!hasAnyInput) {
      setSubmitError('AIデザインまたはエリア編集で、画像かテキストを1つ以上設定してください。');
      return;
    }
    if (requiresAreaPlacement) {
      setSubmitError('エリア編集を使う場合は、範囲選択を1つ以上設定してください。');
      return;
    }
    // フリープランのクレジット枯渇/失効時は生成を抑止（row 49/50）。無効/有料/ゲストでは null=通過。
    const creditMsg = creditBlockMessage(projectSession?.aiCredits);
    if (creditMsg) {
      setSubmitError(creditMsg);
      return;
    }
    void runEdit();
  };

  // コーディネート（完全お任せ）モード（管理表 row 207/213）: 個別指定なしで空間全体を再コーディネートする。
  const runCoordinate = useCallback(async () => {
    if (!activeVersion || isSubmitting) return;
    // フリープランのクレジット枯渇/失効時は生成を抑止（row 49/50）。無効/有料/ゲストでは null=通過。
    const creditMsg = creditBlockMessage(projectSession?.aiCredits);
    if (creditMsg) {
      setSubmitError(creditMsg);
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const baseScaled = await downscaleDataUrlIfNeeded(activeVersion.outputImageDataUrl);
      const { w: baseW, h: baseH } = await loadImageNaturalSize(baseScaled);
      const aspectRatio = pickClosestAspectRatio(baseW, baseH);
      // in-context反映（row 211/219）: 過去に高評価した傾向をコーディネートにも参考添付（ベストエフォート）。
      const learnedHints = await getRecentGoodHints().catch(() => [] as string[]);
      const res = await fetch('/api/ai-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({ baseImage: baseScaled, coordinate: true, aspectRatio, imageSize: '2K', learnedHints }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'コーディネートに失敗しました');
      let outUrl = data.url as string;
      outUrl = await resizeDataUrlToSize(outUrl, baseW, baseH);
      outUrl = await maybeApplyFreePlanOutputLimits(outUrl, isFreePlan);
      setCompareA(activeVersion.outputImageDataUrl);
      setCompareB(outUrl);
      setCompareSlider(50);
      // 暗黙的フィードバック（row 210/216）: 戻って再コーディネートした場合、直前の生成結果を暗黙 bad に。
      const priorChildren = versions.filter((v) => v.parentId === activeVersion.id);
      if (priorChildren.length > 0) {
        const abandoned = priorChildren.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        void recordAiFeedback({
          verdict: 'bad',
          imageRef: abandoned.id,
          feature: 'ai_design',
          promptContext: { implicit: true, signal: 'regenerate' },
        }).catch((e) => console.warn('[ai feedback] 暗黙的bad評価の記録に失敗', e));
      }
      onEditSuccess({
        parentId: activeVersion.id,
        baseImageDataUrl: activeVersion.outputImageDataUrl,
        outputImageDataUrl: outUrl,
        styleRefDataUrl: null,
        styleMemo: '',
        objects: [],
      });
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'エラー');
    } finally {
      setIsSubmitting(false);
    }
  }, [activeVersion, isSubmitting, versions, onEditSuccess, isFreePlan, projectSession]);

  const onMouseDownPlacement = (e: React.MouseEvent) => {
    if (!activeObjectId || !imgRef.current || !baseDisplayUrl) return;
    const img = imgRef.current;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const p = clientToNormalized(e.clientX, e.clientY, img, nw, nh);
    if (!p) return;
    setDragStart(p);
    setDragCurrent(p);
  };

  const onMouseMovePlacement = (e: React.MouseEvent) => {
    if (!dragStart || !imgRef.current) return;
    const img = imgRef.current;
    const p = clientToNormalized(e.clientX, e.clientY, img, img.naturalWidth, img.naturalHeight);
    if (p) setDragCurrent(p);
  };

  const onMouseUpPlacement = () => {
    if (!dragStart || !dragCurrent || !activeObjectId) {
      setDragStart(null);
      setDragCurrent(null);
      return;
    }
    const x0 = Math.min(dragStart.nx, dragCurrent.nx);
    const y0 = Math.min(dragStart.ny, dragCurrent.ny);
    const w = Math.abs(dragCurrent.nx - dragStart.nx);
    const h = Math.abs(dragCurrent.ny - dragStart.ny);
    setDragStart(null);
    setDragCurrent(null);
    if (w < 0.02 || h < 0.02) return;
    const rect: NormalizedRect = {
      x: Math.max(0, x0),
      y: Math.max(0, y0),
      width: Math.min(1 - Math.max(0, x0), w),
      height: Math.min(1 - Math.max(0, y0), h),
    };
    onCommitPlacementRect(activeObjectId, rect);
  };

  if (!isOpen) return null;

  if (!activeVersion) {
    return (
      <div className="fixed inset-0 z-[10000] flex flex-col bg-zinc-950 text-white pl-3 pr-0 pt-0 pb-0">
        <div className="absolute top-6 left-6 right-6 z-50 flex items-start justify-between pointer-events-none">
          {renderModeBarOrHome()}
        </div>
        {!photoOnly && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
            <button
              type="button"
              disabled
              className="pointer-events-auto flex items-center justify-center gap-2 px-8 py-3 rounded-2xl bg-emerald-950/80 border border-emerald-500/40 text-emerald-100 shadow-[0_8px_24px_rgba(16,185,129,0.25)] transition-all disabled:opacity-35 disabled:cursor-not-allowed"
              title="履歴の仕上がり画像が必要です"
            >
              <Download className="w-4 h-4 shrink-0" />
              <span className="text-[11px] font-black uppercase tracking-widest">この画像を書き出し</span>
            </button>
          </div>
        )}
        <div className="flex-1 flex items-center justify-center pt-20">
          {photoOnly ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <p className="text-sm text-neutral-300">写真をアップロードして、AI画像編集を始めましょう。</p>
              <input
                ref={baseInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onPickBaseFile}
              />
              <button
                type="button"
                onClick={() => baseInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-emerald-500"
              >
                <ImagePlus className="h-4 w-4" />
                写真をアップロード
              </button>
              <p className="text-[11px] text-neutral-500">
                JPEG / PNG。アップロード後、AIデザイン・エリア編集・書き出しがご利用いただけます。
              </p>
            </div>
          ) : (
            <p className="text-sm text-neutral-400 text-center max-w-md">
              編集履歴がありません。3Dビューで AI レンダリングを実行してください。
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[10000] flex flex-col bg-zinc-950 text-white pl-3 pr-0 pt-0 pb-0 gap-3">
      <div className="absolute top-6 left-6 right-6 z-50 flex items-start justify-between pointer-events-none">
        {renderModeBarOrHome()}
      </div>
      <div className="absolute top-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <button
          type="button"
          disabled={!activeVersion?.outputImageDataUrl}
          onClick={() => setHighResExportOpen(true)}
          title={
            activeVersion?.outputImageDataUrl
              ? '高解像は API 経由、プレビュー用は元画像をそのまま保存'
              : '履歴の仕上がり画像が必要です'
          }
          className="pointer-events-auto flex items-center justify-center gap-2 px-8 py-3 rounded-2xl bg-emerald-950/80 border border-emerald-500/40 text-emerald-100 shadow-[0_8px_24px_rgba(16,185,129,0.25)] hover:bg-emerald-900/80 transition-all disabled:opacity-35 disabled:cursor-not-allowed"
        >
          <Download className="w-4 h-4 shrink-0" />
          <span className="text-[11px] font-black uppercase tracking-widest">この画像を書き出し</span>
        </button>
      </div>
      <div className="flex flex-1 min-h-0 min-w-0">
        <div className="flex flex-1 min-h-0 min-w-0 pt-20">
        <aside className="w-44 lg:w-52 border-r border-white/10 flex flex-col shrink-0 min-h-0">
          <div className="p-3 pb-2 border-b border-white/10 shrink-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-neutral-500">履歴</div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-2">
            {versions.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelectVersion(v.id)}
                className={`w-full text-left rounded-xl border p-2 transition-colors ${
                  v.id === activeVersionId
                    ? 'border-purple-500/60 bg-purple-500/10'
                    : 'border-white/10 bg-black/30 hover:border-white/20'
                }`}
              >
                <div className="aspect-video rounded-lg overflow-hidden bg-black mb-1">
                  <img src={v.outputImageDataUrl} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="text-[9px] text-neutral-400 font-mono truncate">
                  {new Date(v.createdAt).toLocaleString('ja-JP')}
                </div>
                <div className="text-[9px] text-neutral-500 truncate">自動モード</div>
              </button>
            ))}
          </div>
        </aside>
        <main className="flex-1 flex flex-col min-w-0 gap-3">
          {compareA && compareB && compareA !== compareB && (
            <div className="shrink-0 space-y-1">
              <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">
                比較（実行前 / 実行後）
              </div>
              <div className="relative aspect-video max-h-[28vh] mx-auto rounded-xl overflow-hidden border border-white/10 bg-black">
                <img src={compareA} alt="" className="absolute inset-0 w-full h-full object-contain" />
                <img
                  src={compareB}
                  alt=""
                  className="absolute inset-0 w-full h-full object-contain"
                  style={{ clipPath: `inset(0 ${100 - compareSlider}% 0 0)` }}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={compareSlider}
                  onChange={(e) => setCompareSlider(Number(e.target.value))}
                  className="absolute bottom-2 left-4 right-4 w-[calc(100%-2rem)] accent-purple-500"
                />
              </div>
            </div>
          )}

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider mb-1">
              ベース画像（オブジェクトを選択し、領域をドラッグ）
            </div>
            <div
              ref={wrapRef}
              className="flex-1 relative rounded-xl border border-white/10 bg-black overflow-hidden min-h-[200px]"
            >
              {baseDisplayUrl ? (
                <>
                  <img
                    ref={imgRef}
                    src={baseDisplayUrl}
                    alt="ベース"
                    draggable={false}
                    className="absolute inset-0 w-full h-full object-contain select-none"
                    onLoad={measureLayout}
                    onMouseDown={onMouseDownPlacement}
                    onMouseMove={onMouseMovePlacement}
                    onMouseUp={onMouseUpPlacement}
                    onMouseLeave={onMouseUpPlacement}
                  />
                  {draftObjects.map((o, objIdx) => {
                    const pal = aiEditObjectUiColors(objIdx);
                    return o.placements.map((pl, pi) => {
                      const isSlotActive =
                        o.id === activeObjectId && placementEditIndex === pi;
                      return (
                        <div
                          key={`${o.id}-${pi}`}
                          className="absolute pointer-events-none border-2"
                          style={{
                            left: imgLayout.ox + pl.x * imgLayout.dw,
                            top: imgLayout.oy + pl.y * imgLayout.dh,
                            width: pl.width * imgLayout.dw,
                            height: pl.height * imgLayout.dh,
                            borderColor: pal.border,
                            backgroundColor: pal.fill,
                            boxShadow: isSlotActive ? `0 0 0 2px ${pal.border}` : undefined,
                          }}
                        />
                      );
                    });
                  })}
                  {dragStart && dragCurrent && (
                    <div
                      className="absolute pointer-events-none border-2 border-dashed"
                      style={{
                        left:
                          imgLayout.ox + Math.min(dragStart.nx, dragCurrent.nx) * imgLayout.dw,
                        top:
                          imgLayout.oy + Math.min(dragStart.ny, dragCurrent.ny) * imgLayout.dh,
                        width: Math.abs(dragCurrent.nx - dragStart.nx) * imgLayout.dw,
                        height: Math.abs(dragCurrent.ny - dragStart.ny) * imgLayout.dh,
                        borderColor: dragPreviewColors.border,
                        backgroundColor: dragPreviewColors.fill,
                      }}
                    />
                  )}
                </>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm">
                  ベース画像がありません
                </div>
              )}

              {/* AI生成の評価（good/bad）ボタン＋初回ポップアップ（管理表 row 209/215）。生成画像付近に配置。 */}
              {baseDisplayUrl && activeVersion && (
                <>
                  <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-2 py-1.5 backdrop-blur">
                    <span className="mr-0.5 select-none text-[10px] font-bold text-neutral-400">評価</span>
                    <button
                      type="button"
                      title="この生成結果は良い"
                      aria-label="良い評価"
                      onClick={() => void submitFeedback(activeVersion.id, 'good')}
                      className={`rounded-full p-1.5 transition ${
                        feedbackByVersion[activeVersion.id] === 'good'
                          ? 'bg-emerald-500 text-black'
                          : 'text-neutral-300 hover:bg-white/10 hover:text-emerald-300'
                      }`}
                    >
                      <ThumbsUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      title="この生成結果は悪い"
                      aria-label="悪い評価"
                      onClick={() => void submitFeedback(activeVersion.id, 'bad')}
                      className={`rounded-full p-1.5 transition ${
                        feedbackByVersion[activeVersion.id] === 'bad'
                          ? 'bg-rose-500 text-white'
                          : 'text-neutral-300 hover:bg-white/10 hover:text-rose-300'
                      }`}
                    >
                      <ThumbsDown className="h-4 w-4" />
                    </button>
                  </div>

                  {showFeedbackTip && (
                    <div className="absolute right-3 top-16 z-20 w-60 rounded-xl border border-emerald-500/30 bg-neutral-900/95 p-3 text-[11px] shadow-2xl backdrop-blur">
                      <p className="font-bold text-emerald-300">評価で精度アップ</p>
                      <p className="mt-1 leading-relaxed text-neutral-200">
                        👍 / 👎 で評価すると、AIの生成精度の向上に役立ちます。気軽に押してください。
                      </p>
                      <button
                        type="button"
                        onClick={dismissFeedbackTip}
                        className="mt-2 rounded bg-white/10 px-2.5 py-1 text-[10px] font-bold text-neutral-100 transition hover:bg-white/20"
                      >
                        閉じる
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </main>
        </div>

        {/* App.tsx 3D 右サイドバーと同一構成: 見積を直下配置 → flex-1 列（カタログ相当のスクロール + 下端 CTA） */}
        {/* 親行はルートの px-3 分狭いので、92vw ではなく 92% で 3D 右レールと同程度の見かけ幅に寄せる */}
        <aside className="relative h-full w-[min(440px,92%)] shrink-0 flex flex-col z-20 bg-[#050505] border-l border-white/5 shadow-2xl min-h-0">
          {estimatePanel ?? null}

          <div className="flex-1 flex flex-col min-h-0 relative z-10 bg-[#050505]">
            <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-0 pb-6 space-y-2 md:px-4 md:pb-8 md:space-y-3 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
            <div>
              <div className="text-[10px] font-black uppercase text-neutral-500 tracking-widest mb-2">
                参照画像
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isSubmitting || !activeVersion || !!projectSession?.aiCredits.blocked}
                  onClick={() => void runCoordinate()}
                  title={
                    creditBlockMessage(projectSession?.aiCredits) ??
                    '空間全体をAIにお任せで再コーディネート（家具・装飾・演出を一新）'
                  }
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-purple-900/70 border border-purple-500/30 text-xs font-black text-purple-200 hover:bg-purple-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  AIデザイン提案
                </button>
                <button
                  type="button"
                  onClick={() => setIsSituationCardVisible(true)}
                  className="flex items-center gap-1 px-3 py-2 rounded-lg bg-zinc-800 border border-white/10 text-xs font-bold hover:bg-zinc-700"
                >
                  <ImagePlus className="w-4 h-4" />
                  AIデザイン
                </button>
                <input
                  ref={styleInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickStyleFile}
                />
                <button
                  type="button"
                  onClick={() => onAddObject()}
                  className="flex items-center gap-1 px-3 py-2 rounded-lg bg-zinc-800 border border-white/10 text-xs font-bold hover:bg-zinc-700"
                >
                  <ImagePlus className="w-4 h-4" />
                  エリア編集
                </button>
                <input
                  ref={objectInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickObjectFile}
                />
              </div>
              {isSituationCardVisible && (
                <div className="mt-2 rounded-lg border border-white/10 bg-[rgba(24,24,27,0.5)] p-2 text-xs">
                  <div className="flex items-start gap-2">
                    <div className="w-14 h-14 rounded overflow-hidden border shrink-0 bg-black/40 flex items-center justify-center border-white/20">
                      {styleImageDataUrl ? (
                        <img src={styleImageDataUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[9px] font-bold text-neutral-400 px-1">no image</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] font-bold text-neutral-300">AIデザイン</span>
                        <button
                          type="button"
                          onClick={() => {
                            onStyleRefChange(null);
                            onStyleMemoChange('');
                            setIsSituationCardVisible(false);
                          }}
                          className="p-1 text-red-400 hover:bg-red-500/10 rounded"
                          aria-label="削除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => styleInputRef.current?.click()}
                          className="flex items-center justify-center gap-1 px-2 py-1 rounded border border-white/15 text-[10px] font-bold hover:bg-white/5"
                        >
                          <ImagePlus className="w-3.5 h-3.5" />
                          画像を選択
                        </button>
                        {styleImageDataUrl ? (
                          <button
                            type="button"
                            onClick={() => onStyleRefChange(null)}
                            className="px-2 py-1 rounded border border-white/15 text-[10px] font-bold hover:bg-white/5"
                          >
                            画像を外す
                          </button>
                        ) : null}
                      </div>
                      <textarea
                        value={draftStyleMemo}
                        onChange={(e) => onStyleMemoChange(e.target.value)}
                        placeholder="画像全体をどんな雰囲気にしたいですか？"
                        rows={2}
                        className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] resize-none"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="text-[10px] font-black uppercase text-neutral-500 tracking-widest mb-2">
                エリア編集一覧
              </div>
              <ul className="space-y-2">
                {draftObjects.map((o, objIdx) => {
                  const pal = aiEditObjectUiColors(objIdx);
                  const isActiveObject = o.id === activeObjectId;
                  const appendMode = isActiveObject && placementEditIndex === null;
                  const objectImageDataUrl = normalizeImageDataUrl(o.imageDataUrl);

                  return (
                    <li
                      key={o.id}
                      onClick={() => onActiveObjectChange(o.id === activeObjectId ? null : o.id)}
                      className={`rounded-lg border p-2 text-xs transition-colors ${
                        isActiveObject ? 'ring-1' : ''
                      }`}
                      style={{
                        borderColor: isActiveObject ? pal.border : 'rgba(255,255,255,0.1)',
                        backgroundColor: isActiveObject ? pal.fill : 'rgba(24,24,27,0.5)',
                        boxShadow: isActiveObject ? `inset 0 0 0 1px ${pal.border}33` : undefined,
                      }}
                    >
                      <div className="flex items-start gap-2 cursor-pointer">
                        <div
                          className="w-14 h-14 rounded overflow-hidden border shrink-0 bg-black/40 flex items-center justify-center"
                          style={{ borderColor: pal.border }}
                        >
                          {objectImageDataUrl ? (
                            <img src={objectImageDataUrl} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-[9px] font-bold text-neutral-400 px-1">no image</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[10px] font-bold text-neutral-400">
                              領域 {o.placements.length} 件
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRemoveObject(o.id);
                              }}
                              className="p-1 text-red-400 hover:bg-red-500/10 rounded"
                              aria-label="削除"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                // Keep card selection stable when opening file picker.
                                onActiveObjectChange(o.id);
                                setObjectImageTargetId(o.id);
                                objectInputRef.current?.click();
                              }}
                              className="flex items-center justify-center gap-1 px-2 py-1 rounded border border-white/15 text-[10px] font-bold hover:bg-white/5"
                            >
                              <ImagePlus className="w-3.5 h-3.5" />
                              画像を選択
                            </button>
                            {objectImageDataUrl ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onUpdateObjectImage(o.id, null);
                                }}
                                className="px-2 py-1 rounded border border-white/15 text-[10px] font-bold hover:bg-white/5"
                              >
                                画像を外す
                              </button>
                            ) : null}
                          </div>
                          <textarea
                            value={o.memo}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onUpdateObjectMemo(o.id, e.target.value)}
                            placeholder="このエリア内にどのような編集を加えたいですか？"
                            rows={2}
                            className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] resize-none"
                          />

                          <ul className="space-y-1 mt-1">
                            {o.placements.map((_, pi) => {
                              const slotActive = isActiveObject && placementEditIndex === pi;
                              return (
                                <li
                                  key={pi}
                                  className={`rounded px-1.5 py-1 space-y-1 ${
                                    slotActive ? 'bg-white/10' : 'bg-black/25'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-1">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onSetReplacePlacementMode(o.id, pi);
                                      }}
                                      className="text-[10px] text-left truncate flex-1 underline-offset-2 hover:underline"
                                      style={{ color: pal.border }}
                                    >
                                      範囲 {pi + 1} — 再ドラッグで上書き
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onRemovePlacementAt(o.id, pi);
                                      }}
                                      className="p-0.5 text-neutral-500 hover:text-red-400 rounded"
                                      aria-label="領域を削除"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onActiveObjectChange(o.id);
                              onSetAppendPlacementMode();
                            }}
                            className="mt-1 w-full flex items-center justify-center gap-1 py-1.5 rounded border text-[10px] font-bold border-white/15 hover:bg-white/5"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            範囲を追加
                          </button>
                          {appendMode && (
                            <p className="text-[9px] text-amber-400/90">
                              次のドラッグで新しい範囲を追加します
                            </p>
                          )}
                          {o.placements.length === 0 && (
                            <p className="text-[9px] text-amber-500">範囲未指定（生成不可）</p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            </div>

            <div className="z-40 shrink-0 border-t border-white/10 p-3 bg-[#050505] space-y-2">
              {submitError && <p className="text-xs text-red-400 break-words">{submitError}</p>}
              {emptyCardCount > 0 && (
                <p className="text-xs text-amber-300 font-bold">未入力{emptyCardCount}件</p>
              )}
              {projectSession?.aiCredits.active && (
                <p className={`text-[11px] font-bold ${projectSession.aiCredits.blocked ? 'text-amber-300' : 'text-neutral-400'}`}>
                  無料クレジット 残り {projectSession.aiCredits.remaining} / {projectSession.aiCredits.total} 回
                  {projectSession.aiCredits.expired && '（有効期限切れ）'}
                </p>
              )}
              <button
                type="button"
                disabled={
                  !activeVersion ||
                  isSubmitting ||
                  !hasAnyInput ||
                  requiresAreaPlacement ||
                  emptyCardCount > 0 ||
                  !!projectSession?.aiCredits.blocked
                }
                onClick={handleClickExecute}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:pointer-events-none font-black text-sm"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    生成中…
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" />
                    この内容で編集実行
                  </>
                )}
              </button>
            </div>
          </div>
        </aside>
      </div>

      <HighResExportDialog
        open={highResExportOpen}
        onClose={() => setHighResExportOpen(false)}
        sourceImageDataUrl={activeVersion?.outputImageDataUrl ?? null}
        onExported={() => {
          // 暗黙的フィードバック（管理表 row 210/216・クライアント6/3「保存等」）: 書き出し＝採用とみなし good を記録。
          // in-context反映（row 211/219）用に、その版のスタイル傾向も併せて残す。
          if (!activeVersion) return;
          const styleMemo = activeVersion.styleMemo?.trim() || undefined;
          void recordAiFeedback({
            verdict: 'good',
            imageRef: activeVersion.id,
            feature: 'ai_design',
            promptContext: { implicit: true, signal: 'export', ...(styleMemo ? { styleMemo } : {}) },
          }).catch((e) => console.warn('[ai feedback] 暗黙的good評価の記録に失敗', e));
        }}
      />

      {/* AIエージェント相談パネル（管理表 row 208/214・プランA）。折り畳み式・現在画像を文脈に。 */}
      <AgentChatPanel imageDataUrl={activeVersion?.outputImageDataUrl ?? null} />
    </div>
  );
}
