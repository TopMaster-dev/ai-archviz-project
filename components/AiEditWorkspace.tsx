import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ImagePlus,
  Loader2,
  MessageCircle,
  Plus,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import type { AiEditObjectReference, AiEditVersion, NormalizedRect, AgentCatalogEntry, AgentRecommendation } from '../types.js';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiFeedback, recordImplicitFeedback, getLearnedHints } from '../lib/db/feedback.js';
import { useConfirm } from './ConfirmDialog.js';
import { ensureDataUrl } from '../lib/db/aiRenderStorage.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import { useOptionalProjectSession } from '../lib/project/projectSessionContext.js';
import { useAuth } from '../lib/auth/AuthContext.js';
import { maybeApplyFreePlanOutputLimits } from '../utils/freePlanImage.js';
import { creditBlockMessage } from '../utils/freePlanCredits.js';
import { aiEditObjectUiColors } from '../utils/aiEditObjectPalette.js';
import { downscaleDataUrlIfNeeded } from '../utils/downscaleDataUrl.js';
import { pickClosestAspectRatio } from '../utils/pickClosestAspectRatio.js';
import { fitDataUrlToSize, coverCropLossFraction } from '../utils/fitDataUrl.js';
import { compositeMaskedEdit } from '../utils/compositeMaskedEdit.js';
import { PREVIEW_GEMINI_IMAGE_SIZE } from '../utils/printExportSpec.js';
import { AgentChatPanel } from './AgentChatPanel.js';
import { HighResExportDialog } from './HighResExportDialog.js';
import { ModeToggleBar } from './ModeToggleBar.js';
import { RenderAdColumn } from './AdSlot.js';

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
  /** 生成結果（版）を削除する（260625・削除を暗黙的フィードバックへ）。 */
  onDeleteVersion: (id: string) => void;
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
  /** AIエージェントへ渡す家具カタログ（推薦候補・Tier2 260620）。 */
  agentCatalog?: AgentCatalogEntry[];
  /** エージェント推薦を概算見積もりへ追加する（Tier2）。 */
  onAddEstimateItem?: (rec: AgentRecommendation) => void;
  /** 使い方ガイドを開く（260624: AI画像編集にも「?」を出し、2D/3D 同様に見返せるように）。 */
  onOpenGuide?: () => void;
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
  onDeleteVersion,
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
  onSetReplacePlacementMode,
  onCommitPlacementRect,
  onRemovePlacementAt,
  estimatePanel,
  onEditSuccess,
  photoOnly = false,
  onExitToHome,
  exitToHomeBusy = false,
  onUploadBaseImage,
  agentCatalog,
  onAddEstimateItem,
  onOpenGuide,
}: Props) {
  const [highResExportOpen, setHighResExportOpen] = useState(false);
  // 右サイドバー（見積＋編集パネル）: xl未満はドロワー化（既定で隠す）。xl以上は固定カラム（この状態は無視）。
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 履歴サイドバー: md未満はドロワー化（既定で隠す）。md以上は固定カラム（この状態は無視）。
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);
  const [compareSlider, setCompareSlider] = useState(50);
  const [objectImageTargetId, setObjectImageTargetId] = useState<string | null>(null);
  const [isSituationCardVisible, setIsSituationCardVisible] = useState(false);
  // 右レール「AIマジックツール」のタブ（260624 クライアントUI準拠）: area=エリア編集 / coordinate=コーディネート / agent=相談。
  const [activeTool, setActiveTool] = useState<'area' | 'coordinate' | 'agent'>('area');

  const styleInputRef = useRef<HTMLInputElement>(null);
  const objectInputRef = useRef<HTMLInputElement>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [dragStart, setDragStart] = useState<{ nx: number; ny: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ nx: number; ny: number } | null>(null);
  const [imgLayout, setImgLayout] = useState({ ox: 0, oy: 0, dw: 1, dh: 1 });
  // マスクの描画方式（260623 クライアント要望）: 多角形（クリックで頂点）/ 矩形（従来のドラッグ）。既定=多角形。
  const [maskMode, setMaskMode] = useState<'polygon' | 'rect'>('polygon');
  // 作図中の多角形の頂点（正規化）。3点以上で「確定」または始点付近クリックで閉じる。
  const [polygonPoints, setPolygonPoints] = useState<Array<{ nx: number; ny: number }>>([]);
  // ラバーバンド表示用の現在カーソル位置（正規化）。
  const [polygonCursor, setPolygonCursor] = useState<{ nx: number; ny: number } | null>(null);

  // フリープラン出力制限（縮小＋透かし・row 51/52）用にプランを参照（ゲスト=null=制限なし）。
  const projectSession = useOptionalProjectSession();
  const isFreePlan = projectSession?.plan === 'free';
  // 高解像度DL月次制限の判定用（260624）。AuthProvider 配下なので useAuth は安全（ゲストは userId=null=制限なし）。
  const { userId: authUserId } = useAuth();

  const baseDisplayUrl = activeVersion?.outputImageDataUrl ?? null;

  // AI生成の良し悪し評価（good/bad）。記録は ai_feedback_events へベストエフォート（管理表 row 209/215）。
  const [feedbackByVersion, setFeedbackByVersion] = useState<Record<string, 'good' | 'bad'>>({});
  const feedbackRef = useRef<Record<string, 'good' | 'bad'>>({});
  // 破壊的操作（生成結果の削除）の確認は、ネイティブ window.confirm ではなくアプリ共通のダーク UI モーダルで出す（260625）。
  const confirm = useConfirm();
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
        className="glass pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-2xl border border-emerald-500/30 bg-emerald-500/15 px-4 py-2.5 text-[11px] font-black uppercase tracking-widest text-emerald-300 shadow-xl backdrop-blur-md transition hover:bg-emerald-500/25 hover:text-emerald-100 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:text-emerald-300"
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
      // AI画像編集も 2D/3D と同じく ModeToggleBar 左端の「ホーム」で戻る（260623・配置共通化）。
      <ModeToggleBar
        activeMode="ai"
        onSwitchToSketch={onSwitchToSketch}
        onSwitchTo3D={onSwitchTo3D}
        onSwitchToAi={onSwitchToAiEdit}
        canSwitchTo3D={canSwitchTo3D}
        onGoHome={onExitToHome}
        homeBusy={exitToHomeBusy}
        onHelp={onOpenGuide}
        className="shrink-0"
      />
    );

  const styleImageDataUrl = normalizeImageDataUrl(draftStyleRefDataUrl);
  const hasSituationInput =
    isSituationCardVisible && (!!styleImageDataUrl || draftStyleMemo.trim().length > 0);
  const emptySituationCard =
    activeTool === 'coordinate' &&
    isSituationCardVisible &&
    !styleImageDataUrl &&
    draftStyleMemo.trim().length === 0;
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
      const baseScaled = await downscaleDataUrlIfNeeded(await ensureDataUrl(activeVersion.outputImageDataUrl));
      const { w: baseW, h: baseH } = await loadImageNaturalSize(baseScaled);
      const aspectRatio = pickClosestAspectRatio(baseW, baseH);
      // 生成サイズは動作実績のある AIレンダリングと同じプレビュー用(1K)に揃える。2K のままだと新しい画像
      // モデル(gemini-3-pro-image-preview)で生成が途中劣化し「白っぽくぼやけた」出力になる事象があった
      // （AIレンダリングは PREVIEW_GEMINI_IMAGE_SIZE=1K で正常、AIデザイン/編集だけ 2K で異常・260619報告対応）。
      const imageSize = PREVIEW_GEMINI_IMAGE_SIZE;

      const styleScaled = styleImageDataUrl ? await downscaleDataUrlIfNeeded(await ensureDataUrl(styleImageDataUrl)) : null;
      const objectsScaled = await Promise.all(
        draftObjects.map(async (o) => {
          const norm = normalizeImageDataUrl(o.imageDataUrl);
          return {
            ...o,
            imageDataUrl: norm ? await downscaleDataUrlIfNeeded(await ensureDataUrl(norm)) : null,
          };
        })
      );

      // in-context反映（row 211/219）: 個人の高評価傾向＋全体共有プールを取得し、生成プロンプトへ参考添付（ベストエフォート）。
      const learnedHints = await getLearnedHints().catch(() => [] as string[]);
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
      // トークン計測（row 58・無効時は no-op）。
      void recordAiUsage({ feature: 'ai_edit', usage: data.usage, model: data.model, imageCount: 1, projectId: projectSession?.projectId ?? null });

      let outUrl = data.url as string;
      // ② アスペクト補正（260624 クライアント報告「写真編集で縦に延びる」）: Gemini は対応アスペクト比でしか
      // 生成できないため、強制ストレッチではなく歪まないクロップでベース寸法へ合わせる。極端なアスペクト差は
      // 内容欠落を避けてレターボックス（contain）にフォールバック。
      const { w: gemW, h: gemH } = await loadImageNaturalSize(outUrl);
      const aspectMode: 'cover' | 'contain' =
        coverCropLossFraction(gemW / gemH, baseW / baseH) > 0.1 ? 'contain' : 'cover';
      const normalized = await fitDataUrlToSize(outUrl, baseW, baseH, aspectMode);
      // ① 領域外染み出し対策（260624 クライアント報告「指示にないドライフラワーが増える」）:
      // 純エリア編集（全体スタイル指定なし・アスペクト維持）のときだけ、マスク内だけ Gemini 出力を合成し
      // マスク外はベース画像のまま保持する。全体スタイル併用時は全画面変更を維持するため合成しない。
      const allPlacements = draftObjects.flatMap((o) => o.placements);
      const hasWholeImageStyle =
        isSituationCardVisible && (!!styleImageDataUrl || draftStyleMemo.trim().length > 0);
      outUrl =
        allPlacements.length > 0 && !hasWholeImageStyle && aspectMode === 'cover'
          ? await compositeMaskedEdit(baseScaled, normalized, allPlacements, baseW, baseH)
          : normalized;
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
        void recordImplicitFeedback('regenerate', {
          verdict: 'bad',
          imageRef: abandoned.id,
          styleMemo: abandoned.styleMemo,
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
      const baseScaled = await downscaleDataUrlIfNeeded(await ensureDataUrl(activeVersion.outputImageDataUrl));
      const { w: baseW, h: baseH } = await loadImageNaturalSize(baseScaled);
      const aspectRatio = pickClosestAspectRatio(baseW, baseH);
      // in-context反映（row 211/219）: 過去に高評価した傾向をコーディネートにも参考添付（ベストエフォート）。
      const learnedHints = await getLearnedHints().catch(() => [] as string[]);
      const res = await fetch('/api/ai-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        // 生成サイズはAIレンダリングと同じ 1K に揃える（2K だと新画像モデルでぼやけ出力・260619報告対応）。
        body: JSON.stringify({ baseImage: baseScaled, coordinate: true, aspectRatio, imageSize: PREVIEW_GEMINI_IMAGE_SIZE, learnedHints }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'コーディネートに失敗しました');
      // トークン計測（row 58・無効時は no-op）。
      void recordAiUsage({ feature: 'ai_coordinate', usage: data.usage, model: data.model, imageCount: 1, projectId: projectSession?.projectId ?? null });
      let outUrl = data.url as string;
      // ② アスペクト補正（縦伸び対策・260624）。コーディネートはマスク無しなので全体編集のまま合成しない。
      const { w: gemW, h: gemH } = await loadImageNaturalSize(outUrl);
      const aspectMode: 'cover' | 'contain' =
        coverCropLossFraction(gemW / gemH, baseW / baseH) > 0.1 ? 'contain' : 'cover';
      outUrl = await fitDataUrlToSize(outUrl, baseW, baseH, aspectMode);
      outUrl = await maybeApplyFreePlanOutputLimits(outUrl, isFreePlan);
      setCompareA(activeVersion.outputImageDataUrl);
      setCompareB(outUrl);
      setCompareSlider(50);
      // 暗黙的フィードバック（row 210/216）: 戻って再コーディネートした場合、直前の生成結果を暗黙 bad に。
      const priorChildren = versions.filter((v) => v.parentId === activeVersion.id);
      if (priorChildren.length > 0) {
        const abandoned = priorChildren.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        void recordImplicitFeedback('regenerate', {
          verdict: 'bad',
          imageRef: abandoned.id,
          styleMemo: abandoned.styleMemo,
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

  // コーディネートタブの実行（260624）: プロンプト/添付があればそれを反映（runEdit流用）、無ければ完全お任せ（runCoordinate）。
  // プロンプト未入力でも実行可能（クライアント要望）。
  const handleCoordinateExecute = () => {
    if (!activeVersion || isSubmitting) return;
    const creditMsg = creditBlockMessage(projectSession?.aiCredits);
    if (creditMsg) {
      setSubmitError(creditMsg);
      return;
    }
    setSubmitError(null);
    if (draftStyleMemo.trim().length > 0 || styleImageDataUrl) {
      void runEdit();
    } else {
      void runCoordinate();
    }
  };

  const POLY_CLOSE_DIST = 0.03; // 始点付近クリックで多角形を閉じる距離（正規化）。

  // 作図中の多角形を確定（外接矩形＋頂点を1つの配置として登録）。3点未満なら破棄。
  const commitPolygon = useCallback(() => {
    if (!activeObjectId || polygonPoints.length < 3) {
      setPolygonPoints([]);
      setPolygonCursor(null);
      return;
    }
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const pts = polygonPoints.map((p) => ({ x: clamp01(p.nx), y: clamp01(p.ny) }));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const rect: NormalizedRect = {
      x: minX,
      y: minY,
      width: Math.max(0, Math.max(...xs) - minX),
      height: Math.max(0, Math.max(...ys) - minY),
      points: pts,
    };
    onCommitPlacementRect(activeObjectId, rect);
    setPolygonPoints([]);
    setPolygonCursor(null);
  }, [activeObjectId, polygonPoints, onCommitPlacementRect]);

  const cancelPolygon = useCallback(() => {
    setPolygonPoints([]);
    setPolygonCursor(null);
  }, []);

  // 作図対象（オブジェクト）やマスク方式を切り替えたら、作図中の多角形は破棄する。
  useEffect(() => {
    setPolygonPoints([]);
    setPolygonCursor(null);
  }, [activeObjectId, maskMode]);

  const onMouseDownPlacement = (e: React.MouseEvent) => {
    if (!activeObjectId || !imgRef.current || !baseDisplayUrl) return;
    const img = imgRef.current;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const p = clientToNormalized(e.clientX, e.clientY, img, nw, nh);
    if (!p) return;
    if (maskMode === 'polygon') {
      // 3点以上で始点付近をクリックしたら閉じる。それ以外は頂点を1つ追加する。
      if (polygonPoints.length >= 3) {
        const first = polygonPoints[0];
        if (Math.hypot(p.nx - first.nx, p.ny - first.ny) < POLY_CLOSE_DIST) {
          commitPolygon();
          return;
        }
      }
      setPolygonPoints((prev) => [...prev, p]);
      return;
    }
    setDragStart(p);
    setDragCurrent(p);
  };

  const onMouseMovePlacement = (e: React.MouseEvent) => {
    if (!imgRef.current) return;
    const img = imgRef.current;
    const p = clientToNormalized(e.clientX, e.clientY, img, img.naturalWidth, img.naturalHeight);
    if (maskMode === 'polygon') {
      // 1点以上打ってあれば、次の頂点候補（ラバーバンド）を表示する。
      if (polygonPoints.length > 0) setPolygonCursor(p);
      return;
    }
    if (!dragStart) return;
    if (p) setDragCurrent(p);
  };

  const onMouseUpPlacement = () => {
    if (maskMode === 'polygon') return; // 多角形はクリックで頂点追加するためドラッグ確定しない。
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
        <div className="absolute top-6 left-6 right-6 z-50 flex flex-wrap items-start justify-between gap-2 pointer-events-none">
          {renderModeBarOrHome()}
          {!photoOnly && (
            <button
              type="button"
              disabled
              className="pointer-events-auto lg:absolute lg:top-0 lg:left-1/2 lg:-translate-x-1/2 shrink-0 flex items-center justify-center gap-2 px-4 sm:px-8 py-3 rounded-2xl bg-emerald-950/80 border border-emerald-500/40 text-emerald-100 shadow-[0_8px_24px_rgba(16,185,129,0.25)] transition-all disabled:opacity-35 disabled:cursor-not-allowed"
              title="履歴の仕上がり画像が必要です"
            >
              <Download className="w-4 h-4 shrink-0" />
              <span className="text-[11px] font-black uppercase tracking-widest">この画像を書き出し</span>
            </button>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center pt-32 sm:pt-20">
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
      {/* 上部バー: モード切替（左）＋ 書き出し（右）。狭幅は折り返す（中央固定だとモード切替に重なるため）。 */}
      <div className="absolute top-6 left-6 right-6 z-50 flex flex-wrap items-start justify-between gap-2 pointer-events-none">
        {renderModeBarOrHome()}
        <button
          type="button"
          disabled={!activeVersion?.outputImageDataUrl}
          onClick={() => setHighResExportOpen(true)}
          title={
            activeVersion?.outputImageDataUrl
              ? '高解像は API 経由、プレビュー用は元画像をそのまま保存'
              : '履歴の仕上がり画像が必要です'
          }
          className="pointer-events-auto lg:absolute lg:top-0 lg:left-1/2 lg:-translate-x-1/2 shrink-0 flex items-center justify-center gap-2 px-4 sm:px-8 py-3 rounded-2xl bg-emerald-950/80 border border-emerald-500/40 text-emerald-100 shadow-[0_8px_24px_rgba(16,185,129,0.25)] hover:bg-emerald-900/80 transition-all disabled:opacity-35 disabled:cursor-not-allowed"
        >
          <Download className="w-4 h-4 shrink-0" />
          <span className="text-[11px] font-black uppercase tracking-widest">この画像を書き出し</span>
        </button>
      </div>
      <div className="flex flex-1 min-h-0 min-w-0">
        {/* pt: 狭幅は上部バーが2段に折り返すため広めに確保（重なり防止）。sm以上は1段なので従来どおり。 */}
        <div className="flex flex-1 min-h-0 min-w-0 pt-32 sm:pt-20">
        {/* 履歴。md未満はドロワー（左端タブで開閉）→ 狭幅で中央の編集画像を潰さない。md以上は固定カラム。 */}
        {!historyOpen && (
          <button
            type="button"
            onClick={() => { setHistoryOpen(true); setSidebarOpen(false); }}
            className="md:hidden fixed left-0 top-1/2 z-[60] -translate-y-1/2 flex items-center gap-1.5 rounded-r-2xl border border-l-0 border-white/15 bg-[#0d0d0d]/95 py-3 pl-2 pr-3 text-[11px] font-black tracking-widest text-emerald-200 shadow-2xl backdrop-blur-md tap focus-ring"
            aria-label="履歴を開く"
          >
            <ChevronRight className="h-4 w-4 shrink-0" />
            履歴
          </button>
        )}
        {historyOpen && (
          <div className="md:hidden fixed inset-0 z-[60] bg-black/60" onClick={() => setHistoryOpen(false)} aria-hidden />
        )}
        <aside
          className={`fixed inset-y-0 left-0 z-[61] w-[min(80vw,240px)] bg-zinc-950 md:static md:z-auto md:w-44 lg:w-52 md:bg-transparent border-r border-white/10 flex flex-col shrink-0 min-h-0 transition-transform duration-300 ${
            historyOpen ? 'translate-x-0' : '-translate-x-[110%]'
          } md:translate-x-0`}
        >
          <div className="p-3 pb-2 border-b border-white/10 shrink-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-neutral-500">履歴</div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-2">
            {/* 新しい生成ほど上（新しい順・降順）に並べる（260623 クライアント要望）。 */}
            {[...versions]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((v) => (
                <div
                  key={v.id}
                  className={`w-full rounded-xl border p-2 transition-colors ${
                    v.id === activeVersionId
                      ? 'border-purple-500/60 bg-purple-500/10'
                      : 'border-white/10 bg-black/30 hover:border-white/20'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectVersion(v.id)}
                    className="block w-full text-left"
                  >
                    <div className="aspect-video rounded-lg overflow-hidden bg-black mb-1">
                      <img src={v.outputImageDataUrl} alt="" className="w-full h-full object-cover" />
                    </div>
                    <div className="text-[9px] text-neutral-400 font-mono truncate">
                      {new Date(v.createdAt).toLocaleString('ja-JP')}
                    </div>
                    <div className="text-[9px] text-neutral-500 truncate">自動モード</div>
                  </button>
                  {/* 各履歴サムネの下に good/bad 評価を表示。ホバーでボタン＋アイコンを強調（260623）。 */}
                  <div className="mt-1.5 flex items-center gap-1 border-t border-white/5 pt-1.5">
                    <span className="mr-0.5 select-none text-[9px] font-bold text-neutral-500">評価</span>
                    <button
                      type="button"
                      title="この生成結果は良い"
                      aria-label="良い評価"
                      onClick={() => void submitFeedback(v.id, 'good')}
                      className={`rounded-full p-1 transition ${
                        feedbackByVersion[v.id] === 'good'
                          ? 'bg-emerald-500 text-black'
                          : 'text-neutral-400 hover:scale-110 hover:bg-emerald-500/20 hover:text-emerald-300'
                      }`}
                    >
                      <ThumbsUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="この生成結果は悪い"
                      aria-label="悪い評価"
                      onClick={() => void submitFeedback(v.id, 'bad')}
                      className={`rounded-full p-1 transition ${
                        feedbackByVersion[v.id] === 'bad'
                          ? 'bg-rose-500 text-white'
                          : 'text-neutral-400 hover:scale-110 hover:bg-rose-500/20 hover:text-rose-300'
                      }`}
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                    </button>
                    {/* 削除: 生成結果を消す。同時に「削除＝強いbad」の暗黙的フィードバックを記録する（260625）。 */}
                    <button
                      type="button"
                      title="この生成結果を削除"
                      aria-label="生成結果を削除"
                      onClick={async () => {
                        // アプリ共通の確認モーダル（ダーク UI）。OK で true・キャンセル/ESC/背景クリックで false。
                        const ok = await confirm({
                          title: '生成結果の削除',
                          message: 'この生成結果を削除しますか？\n（元に戻せません）',
                          confirmLabel: '削除',
                          danger: true,
                        });
                        if (!ok) return;
                        // 暗黙的フィードバック（260625）: 削除＝強い bad シグナル。styleMemo も学習用に残す。
                        void recordImplicitFeedback('delete', {
                          verdict: 'bad',
                          imageRef: v.id,
                          styleMemo: v.styleMemo,
                        }).catch((e) => console.warn('[ai feedback] 削除シグナルの記録に失敗', e));
                        // UI 評価状態の掃除（削除済み版の孤立エントリを残さない）。
                        feedbackRef.current = Object.fromEntries(
                          Object.entries(feedbackRef.current).filter(([id]) => id !== v.id),
                        );
                        setFeedbackByVersion({ ...feedbackRef.current });
                        onDeleteVersion(v.id);
                      }}
                      className="ml-auto rounded-full p-1 text-neutral-400 transition hover:scale-110 hover:bg-red-500/20 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
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
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="truncate text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                {maskMode === 'polygon'
                  ? 'ベース画像（オブジェクト選択→クリックで頂点／始点付近クリックか確定で閉じる）'
                  : 'ベース画像（オブジェクトを選択し、領域をドラッグ）'}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* マスク方式の切替（260623）。多角形＝クリックで頂点、矩形＝従来のドラッグ。 */}
                <div className="glass flex rounded-lg border border-white/10 p-0.5">
                  <button
                    type="button"
                    onClick={() => setMaskMode('polygon')}
                    className={`rounded-md px-2 py-1 text-[10px] font-black tracking-wider transition-colors ${
                      maskMode === 'polygon' ? 'bg-white text-black' : 'text-white/55 hover:text-white'
                    }`}
                  >
                    多角形
                  </button>
                  <button
                    type="button"
                    onClick={() => setMaskMode('rect')}
                    className={`rounded-md px-2 py-1 text-[10px] font-black tracking-wider transition-colors ${
                      maskMode === 'rect' ? 'bg-white text-black' : 'text-white/55 hover:text-white'
                    }`}
                  >
                    矩形
                  </button>
                </div>
                {maskMode === 'polygon' && polygonPoints.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={commitPolygon}
                      disabled={polygonPoints.length < 3}
                      className="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-1 text-[10px] font-black tracking-wider text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-40"
                    >
                      確定（{polygonPoints.length}点）
                    </button>
                    <button
                      type="button"
                      onClick={cancelPolygon}
                      className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-black tracking-wider text-white/60 transition-colors hover:text-white"
                    >
                      取消
                    </button>
                  </>
                )}
              </div>
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
                    className={`absolute inset-0 w-full h-full object-contain select-none ${
                      activeObjectId ? 'cursor-crosshair' : ''
                    }`}
                    onLoad={measureLayout}
                    onMouseDown={onMouseDownPlacement}
                    onMouseMove={onMouseMovePlacement}
                    onMouseUp={onMouseUpPlacement}
                    onMouseLeave={() => {
                      if (maskMode === 'polygon') setPolygonCursor(null);
                      else onMouseUpPlacement();
                    }}
                  />
                  {draftObjects.map((o, objIdx) => {
                    const pal = aiEditObjectUiColors(objIdx);
                    return o.placements.map((pl, pi) => {
                      // 多角形マスクは下の SVG レイヤで描画するため、矩形 div はスキップ。
                      if (pl.points && pl.points.length >= 3) return null;
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
                  {/* 多角形マスク（260623）: 確定済み多角形＋作図中の多角形を SVG で描画。 */}
                  <svg className="absolute inset-0 h-full w-full pointer-events-none" aria-hidden>
                    {draftObjects.map((o, objIdx) => {
                      const pal = aiEditObjectUiColors(objIdx);
                      return o.placements.map((pl, pi) => {
                        if (!pl.points || pl.points.length < 3) return null;
                        const isSlotActive =
                          o.id === activeObjectId && placementEditIndex === pi;
                        const ptsStr = pl.points
                          .map(
                            (p) =>
                              `${imgLayout.ox + p.x * imgLayout.dw},${imgLayout.oy + p.y * imgLayout.dh}`
                          )
                          .join(' ');
                        return (
                          <polygon
                            key={`poly-${o.id}-${pi}`}
                            points={ptsStr}
                            fill={pal.fill}
                            stroke={pal.border}
                            strokeWidth={isSlotActive ? 3 : 2}
                            strokeLinejoin="round"
                          />
                        );
                      });
                    })}
                    {maskMode === 'polygon' &&
                      polygonPoints.length > 0 &&
                      (() => {
                        const px = polygonPoints.map((p) => ({
                          x: imgLayout.ox + p.nx * imgLayout.dw,
                          y: imgLayout.oy + p.ny * imgLayout.dh,
                        }));
                        const cursorPx = polygonCursor
                          ? {
                              x: imgLayout.ox + polygonCursor.nx * imgLayout.dw,
                              y: imgLayout.oy + polygonCursor.ny * imgLayout.dh,
                            }
                          : null;
                        const lineStr =
                          px.map((p) => `${p.x},${p.y}`).join(' ') +
                          (cursorPx ? ` ${cursorPx.x},${cursorPx.y}` : '');
                        return (
                          <>
                            <polyline
                              points={lineStr}
                              fill="none"
                              stroke={dragPreviewColors.border}
                              strokeWidth={2}
                              strokeDasharray="5 3"
                              strokeLinejoin="round"
                            />
                            {px.map((p, i) => (
                              <circle
                                key={i}
                                cx={p.x}
                                cy={p.y}
                                r={i === 0 ? 5.5 : 3.5}
                                fill={i === 0 ? dragPreviewColors.border : '#ffffff'}
                                stroke={dragPreviewColors.border}
                                strokeWidth={1.5}
                              />
                            ))}
                          </>
                        );
                      })()}
                  </svg>
                </>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm">
                  ベース画像がありません
                </div>
              )}

              {/* 評価（good/bad）は左の履歴パネル（各サムネ下）に集約（260623）。画像右上の評価ピル＋初回ヒントは廃止。 */}
            </div>
          </div>
        </main>
        </div>

        {/* 見積＋編集パネル。3D右レールと同一構成。xl未満はドロワー（既定で隠し、右端タブで開閉）→ 狭幅で中央の編集画像を潰さない。xl以上は従来の固定カラム。 */}
        {/* 狭幅: ドロワーを開くタブ（閉じている間だけ表示） */}
        {!sidebarOpen && (
          <button
            type="button"
            onClick={() => { setSidebarOpen(true); setHistoryOpen(false); }}
            className="xl:hidden fixed right-0 top-1/2 z-[60] -translate-y-1/2 flex items-center gap-1.5 rounded-l-2xl border border-r-0 border-white/15 bg-[#0d0d0d]/95 py-3 pl-3 pr-2 text-[11px] font-black tracking-widest text-emerald-200 shadow-2xl backdrop-blur-md tap focus-ring safe-r"
            aria-label="見積・編集パネルを開く"
          >
            <ChevronLeft className="h-4 w-4 shrink-0" />
            見積
          </button>
        )}
        {/* 狭幅: ドロワー背景（タップで閉じる） */}
        {sidebarOpen && (
          <div className="xl:hidden fixed inset-0 z-[60] bg-black/60" onClick={() => setSidebarOpen(false)} aria-hidden />
        )}
        <aside
          className={`fixed inset-y-0 right-0 z-[61] w-[min(92vw,400px)] xl:static xl:z-20 xl:w-[min(440px,92%)] h-full flex flex-col shrink-0 bg-[#050505] border-l border-white/5 shadow-2xl min-h-0 transition-transform duration-300 ${
            sidebarOpen ? 'translate-x-0' : 'translate-x-full'
          } xl:translate-x-0`}
        >
          {estimatePanel ?? null}

          <div className="flex-1 flex flex-col min-h-0 relative z-10 bg-[#050505]">
            <div
              className={`flex-1 min-h-0 px-3 pt-0 space-y-2 md:px-4 md:space-y-3 scroll-dark ${
                activeTool === 'agent'
                  ? 'flex flex-col overflow-hidden pb-3 md:pb-4'
                  : 'overflow-y-auto pb-6 md:pb-8'
              }`}
            >
            <div>
              <div className="text-[10px] font-black uppercase text-neutral-500 tracking-widest mb-2">
                AI マジックツール
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setActiveTool('area')}
                  className={`flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg border text-xs font-bold transition ${
                    activeTool === 'area'
                      ? 'bg-emerald-600/15 border-emerald-500 text-emerald-100'
                      : 'bg-zinc-800 border-white/10 text-neutral-200 hover:bg-zinc-700'
                  }`}
                >
                  <ImagePlus className="w-4 h-4 shrink-0" />
                  エリア編集
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTool('coordinate');
                    setIsSituationCardVisible(true);
                  }}
                  className={`flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg border text-xs font-bold transition ${
                    activeTool === 'coordinate'
                      ? 'bg-emerald-600/15 border-emerald-500 text-emerald-100'
                      : 'bg-zinc-800 border-white/10 text-neutral-200 hover:bg-zinc-700'
                  }`}
                >
                  <Sparkles className="w-4 h-4 shrink-0" />
                  コーディネート
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTool('agent')}
                  title="AIエージェントに相談（デザイン・素材・見積の相談）"
                  className={`flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg border text-xs font-bold transition ${
                    activeTool === 'agent'
                      ? 'bg-emerald-600/15 border-emerald-500 text-emerald-100'
                      : 'bg-zinc-800 border-white/10 text-neutral-200 hover:bg-zinc-700'
                  }`}
                >
                  <MessageCircle className="w-4 h-4 shrink-0" />
                  エージェントに相談
                </button>
                <input
                  ref={styleInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickStyleFile}
                />
                <input
                  ref={objectInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickObjectFile}
                />
              </div>
              {activeTool === 'coordinate' && (
                <div className="mt-2 space-y-2">
                  <p className="text-[10px] font-bold text-neutral-500">＊任意</p>
                  <textarea
                    value={draftStyleMemo}
                    onChange={(e) => onStyleMemoChange(e.target.value)}
                    placeholder={
                      '例）このブランドに合うデザインを提案して\n（HPに掲載されている企業理念や現在の展開されている店舗画像、今回の提案要件を記入してください）\n例）この空間に合う家具を提案して'
                    }
                    rows={6}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-white leading-relaxed resize-none outline-none focus:border-emerald-500"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => styleInputRef.current?.click()}
                      className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-white/10 text-[11px] font-bold hover:bg-zinc-700"
                    >
                      <ImagePlus className="w-4 h-4" />
                      ファイルを添付
                    </button>
                    {styleImageDataUrl && (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onStyleRefChange(null)}
                          className="shrink-0 rounded p-1 text-red-400 hover:bg-red-500/10"
                          aria-label="添付を削除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <img src={styleImageDataUrl} alt="添付" className="h-7 w-7 shrink-0 rounded object-cover" />
                        <span className="truncate text-[10px] text-neutral-400">添付画像</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {activeTool === 'area' && (
            <div>
              {draftObjects.length === 0 && (
                <p className="text-[11px] leading-relaxed text-neutral-500 py-2">
                  「＋範囲を追加」を押して、編集したい範囲（領域）を追加してください。
                </p>
              )}
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
                                      範囲 {pi + 1} — {maskMode === 'polygon' ? '再作図で上書き' : '再ドラッグで上書き'}
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

                          {appendMode && (
                            <p className="text-[9px] text-amber-400/90">
                              {maskMode === 'polygon'
                                ? '画像上をクリックして頂点を打ち、新しい範囲を作図します'
                                : '次のドラッグで新しい範囲を追加します'}
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
              {/* グローバルな「範囲を追加」: クリックで新しい領域カードを追加（260624 クライアントUI準拠）。 */}
              <button
                type="button"
                onClick={() => onAddObject()}
                className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-white/15 bg-zinc-800/60 text-xs font-bold hover:bg-zinc-700/60 transition"
              >
                <Plus className="w-4 h-4" />
                範囲を追加
              </button>
            </div>
            )}
            {/* エージェント相談はタブとして右レール内にインライン表示（260624・フローティング廃止）。
                flex-1 でレール残り高さいっぱいに広げる。 */}
            {activeTool === 'agent' && (
              <div className="flex min-h-0 flex-1">
                <AgentChatPanel
                  inline
                  open
                  imageDataUrl={activeVersion?.outputImageDataUrl ?? null}
                  projectId={projectSession?.projectId ?? null}
                  onOpenChange={(o) => {
                    if (!o) setActiveTool('area');
                  }}
                  catalog={agentCatalog}
                  onAddEstimateItem={onAddEstimateItem}
                />
              </div>
            )}
            </div>

            {activeTool !== 'agent' && (
            <div className="z-40 shrink-0 border-t border-white/10 p-3 bg-[#050505] space-y-2">
              {submitError && <p className="text-xs text-red-400 break-words">{submitError}</p>}
              {activeTool === 'area' && emptyCardCount > 0 && (
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
                  !!projectSession?.aiCredits.blocked ||
                  (activeTool === 'area' &&
                    (!hasAnyInput || requiresAreaPlacement || emptyCardCount > 0))
                }
                onClick={activeTool === 'coordinate' ? handleCoordinateExecute : handleClickExecute}
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
                    {activeTool === 'coordinate' ? '実行ボタン' : 'この内容で編集実行'}
                  </>
                )}
              </button>
            </div>
            )}
          </div>
        </aside>
      </div>

      <HighResExportDialog
        open={highResExportOpen}
        onClose={() => setHighResExportOpen(false)}
        sourceImageDataUrl={activeVersion?.outputImageDataUrl ?? null}
        plan={projectSession?.plan ?? null}
        userId={authUserId}
        projectName={projectSession?.projectName ?? null}
        onExported={() => {
          // 暗黙的フィードバック（管理表 row 210/216・クライアント6/3「保存等」）: 書き出し＝採用とみなし good を記録。
          // in-context反映（row 211/219）用に、その版のスタイル傾向も併せて残す。
          if (!activeVersion) return;
          const styleMemo = activeVersion.styleMemo?.trim() || undefined;
          void recordImplicitFeedback('export', {
            verdict: 'good',
            imageRef: activeVersion.id,
            styleMemo,
          }).catch((e) => console.warn('[ai feedback] 暗黙的good評価の記録に失敗', e));
        }}
      />

      {/* AI生成中の全面オーバーレイ（クライアント要望 260619: ボタンの小さなスピナーだけでは処理中か
          分かりにくいため、AIデザイン提案/編集実行の実行中をはっきり示す。3Dレンダのオーバーレイと同方針）。 */}
      {isSubmitting && (
        <div className="fixed inset-0 z-[10050] flex flex-col items-center justify-center bg-zinc-950/90 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-6 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-8 text-center shadow-2xl">
            <Loader2 className="h-14 w-14 animate-spin text-purple-400" />
            <div>
              <h3 className="mb-2 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-xl font-bold text-transparent">
                AIが画像を生成中…
              </h3>
              <p className="text-sm text-zinc-400">しばらくお待ちください。</p>
            </div>
          </div>
          {/* 生成待ち時間に広告を表示（260624・仮 Google AdSense）。 */}
          <RenderAdColumn className="absolute right-6 top-1/2 -translate-y-1/2" />
        </div>
      )}
    </div>
  );
}
