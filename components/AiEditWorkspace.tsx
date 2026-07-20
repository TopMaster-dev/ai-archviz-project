import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ImagePlus,
  Loader2,
  MessageCircle,
  Paperclip,
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
import { compressDataUrlToBudget, dataUrlTransmitBytes } from '../utils/compressDataUrl.js';
import { pickClosestAspectRatio } from '../utils/pickClosestAspectRatio.js';
import { fitDataUrlToSize, coverCropLossFraction } from '../utils/fitDataUrl.js';
import { compositeMaskedEdit } from '../utils/compositeMaskedEdit.js';
import { sanitizeDetectedOpenings } from '../utils/openingRects.js';
import { harmonizeEditToBase } from '../utils/tonalMatch.js';
import { shouldCompositeAreaEdit, GLOBAL_REGION_COVERAGE } from '../utils/areaEditDecision.js';
import {
  unionBBoxOfPlacements,
  padBBox,
  parseAspectRatioKey,
  snapCropToAspect,
  remapPlacementsToCrop,
  shouldCropRegion,
  isConfinedRegion,
  type CropPx,
} from '../utils/maskCropRemap.js';
import { cropDataUrl, pasteCropIntoBase } from '../utils/cropPasteCanvas.js';
import { PREVIEW_GEMINI_IMAGE_SIZE } from '../utils/printExportSpec.js';
import {
  ENABLE_HARMONIZE_FLATTEN,
  ENABLE_KEEP_QUALITY_ENHANCE,
  ENABLE_OPENING_PRESERVE,
  ENABLE_AREA_EDIT_SURFACE_FULLFRAME,
  isSurfacePlaneFinish,
} from '../lib/aiEditPrompt.js';
import { MAX_STYLE_REFS } from '../hooks/useAiEditSession.js';
import { AgentChatPanel } from './AgentChatPanel.js';
import { HighResExportDialog } from './HighResExportDialog.js';
import { ModeToggleBar } from './ModeToggleBar.js';
import { EditorHelpButton } from './EditorHelpButton.js';
import { RenderInfoColumn } from './RenderInfoColumn.js';
import { ImageCropDialog } from './ImageCropDialog.js';

function normalizeImageDataUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return null;
  return s;
}

/** applyAreaEditFinish に渡す“仕上げ段”のコンテキスト（生成入力に依存する値。候補ごとに保持し、本番確定で再利用する・point2）。 */
type AreaEditFinishCtx = {
  baseW: number;
  baseH: number;
  imageSize: string;
  editedHasReplacement: boolean;
  skipFinishFor1B: boolean;
  anyComposited: boolean;
  allPlacements: NormalizedRect[];
  surfaceOnly: boolean;
  openings: NormalizedRect[];
  keepQuality: boolean;
  isFreePlan: boolean;
};

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
  if (dw <= 0 || dh <= 0) return null;
  // 用紙(画像)範囲外（レターボックス）でクリックしても、最も近い画像の端に丸めて頂点にする＝
  // 用紙いっぱいまで（端まで）きれいに範囲指定できる（260717 クライアント要望⑤）。従来は範囲外を無視していた。
  const lx = Math.min(dw, Math.max(0, clientX - r.left - ox));
  const ly = Math.min(dh, Math.max(0, clientY - r.top - oy));
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
  /** 生成結果への good/bad 評価を版に保存（プロジェクト永続化＝開き直しても表示を保つ・260707）。 */
  onSetVersionFeedback?: (id: string, verdict: 'good' | 'bad') => void;
  /** コーディネートのスタイル参照画像（複数対応・260707）。 */
  draftStyleRefs: string[];
  onAddStyleRefs: (dataUrls: string[]) => void;
  onRemoveStyleRefAt: (index: number) => void;
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
    styleRefDataUrls: string[];
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

// 送信ペイロード予算（≈ data URL 文字数＝JSON body に載るバイト）。Vercel サーバレス関数の body 上限(~4.5MB)を
// 超えると原因不明の失敗になるため、差し替え経路で base/参照を予算内へ圧縮し、なお超える場合だけ明確に止める（260718）。
const SEND_REF_MAX_BYTES = 1_300_000; // 参照画像1枚の送信サイズ上限
const SEND_BASE_MAX_BYTES = 2_200_000; // 送信用 base（合成には元画像を使うので画質に影響しない）
const SEND_BODY_MAX_BYTES = 4_200_000; // base+参照1枚の合計がこれを超えたら明確なメッセージで停止（~4.5MB の手前）

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
  onSetVersionFeedback,
  draftStyleRefs,
  onAddStyleRefs,
  onRemoveStyleRefAt,
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
  // 一部の範囲だけ失敗したときの“警告”（結果は反映されるがエラーではない・260715 監査対応の無言失敗の可視化）。
  const [submitWarning, setSubmitWarning] = useState<string | null>(null);
  // 継ぎ目なじませ（全体を1枚に均一化）パスの opt-in（既定OFF・260706 クライアント提案）。
  const [harmonizeSeams, setHarmonizeSeams] = useState(false);
  // 囲った範囲（マスク）オーバーレイの表示トグル（260708 クライアント要望「任意で表示・非表示」）。
  // 既定はON＝エリア編集タブでは囲った範囲を表示する（クライアント確認「エリアのみ表示が正」）。
  // コーディネート/エージェント相談タブでは常に非表示（下の overlayObjects で activeTool 分岐）。
  // 「範囲: 非表示」ボタンでいつでも隠せる（任意で表示・非表示）。設定は localStorage に保持。
  const [showRangeOverlay, setShowRangeOverlay] = useState<boolean>(() => {
    try {
      return localStorage.getItem('archviz-ai-edit-show-range') !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('archviz-ai-edit-show-range', showRangeOverlay ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [showRangeOverlay]);
  // 「画質を保つ」トグル（260708・クライアント提案のハイブリッド方式）。編集を繰り返すと直近の出力を土台にするため
  // 画質が徐々に劣化する。ON にすると、土台（base）は従来どおり直近の画像のまま＝連続編集のワークフローを維持しつつ、
  // 最初のレンダリング画像を「画質・素材・質感の見本」として毎回一緒に渡す。形・位置・これまでの変更は直近画像に従い、
  // 見本は画質の参照だけに使う（＝編集を巻き戻さない）。既定OFF・非永続（毎回の明示選択）。
  const [keepQuality, setKeepQuality] = useState(false);
  // 複数候補から選ぶ（Option 1・260717 クライアント要望）。同一入力で candidateCount 回生成し最良の1枚を選ぶ
  // ＝AI生成のばらつきを味方につける（③④の“当たり外れ”対策）。既定 1（従来どおり＝コスト据え置き）。
  const [candidateCount, setCandidateCount] = useState(1);
  // 生成した複数候補と、採用時に版を作るための親情報。null のときピッカー非表示。
  const [candidatePick, setCandidatePick] = useState<
    { parentId: string; baseImageDataUrl: string; candidates: { url: string; ctx: AreaEditFinishCtx }[] } | null
  >(null);
  // 選んだ候補を本番確定（仕上げ Gemini パス）している最中のローディング（point2・260721）。
  const [finalizingCandidate, setFinalizingCandidate] = useState(false);
  // 【生成中の進捗表示（260720 クライアント要望 point3）】3枚生成でロードが長くなり「固まった？」と不安になる問題への対策。
  // 候補は逐次生成（下の候補ループが await 逐次）のため「N/total 完了」を実測でき、完了した候補は届いた順にサムネで
  // 見せられる＝進んでいることが見える＝最大の不安解消。正確な％は生成APIが途中経過を返さないため出さない（作り物にしない）。
  const [genProgress, setGenProgress] = useState<{ total: number; done: string[] } | null>(null);
  const [genElapsedSec, setGenElapsedSec] = useState(0);
  // 経過秒カウントアップ（実測＝誠実）。生成中(isSubmitting)だけ動かし、終了で 0 に戻す。
  useEffect(() => {
    if (!isSubmitting) {
      setGenElapsedSec(0);
      return;
    }
    setGenElapsedSec(0);
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setGenElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [isSubmitting]);
  // AI編集キャンバスの閲覧ズーム（260708 クライアント要望）: マウスホイールで拡大縮小し細部を確認できる
  // （DL→Photoshop/プロパティで確認する手間の削減）。表示専用＝拡大中は作図を無効化しドラッグはパン（移動）、
  // 等倍(1)で作図に戻る。imgLayout は wrapper 実寸から算出＝変形に依存しないので、画像＋オーバーレイをまとめて
  // CSS transform でスケール／パンしてもマスクの位置はずれない。
  const MAX_ZOOM = 6;
  const ZOOM_MIN_SNAP = 1.001; // 浮動小数の丸め対策: これ以下は等倍(1)へスナップしパンをリセットする。
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const panRef = useRef({ x: 0, y: 0 });
  panRef.current = pan;
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

  // AI生成の良し悪し評価（good/bad）。表示状態は「版」に保存してプロジェクト永続化＝開き直しても残す（260707
  // クライアント要望）。学習用の記録は従来どおり ai_feedback_events へベストエフォート（管理表 row 209/215）。
  // 破壊的操作（生成結果の削除）の確認は、ネイティブ window.confirm ではなくアプリ共通のダーク UI モーダルで出す（260625）。
  const confirm = useConfirm();
  const submitFeedback = useCallback(
    async (versionId: string, verdict: 'good' | 'bad') => {
      const v = versions.find((x) => x.id === versionId);
      if (!versionId || !v || v.feedback === verdict) return;
      onSetVersionFeedback?.(versionId, verdict); // 版に保存＝プロジェクトへ永続化（開き直しても表示が残る）
      // in-context反映（row 211/219）用に、その版のスタイル傾向（styleMemo）を併せて記録する。
      const styleMemo = v.styleMemo?.trim() || undefined;
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
    [versions, onSetVersionFeedback],
  );


  const activeObjectIndex = draftObjects.findIndex((o) => o.id === activeObjectId);

  // 囲った範囲（マスク）オーバーレイの表示ソース（260708 クライアント要望）:
  //  - コーディネート／エージェント相談タブでは常に非表示（エリア編集専用の目印のため・activeTool 分岐）。
  //  - エリア編集タブでは draftObjects を描く。履歴の版を選ぶと hydrateDraftFromVersion がその版の領域を
  //    draftObjects へ復元するので、右パネルの領域カード（範囲＋画像＋指示文）が必ず埋まる（「範囲だけ出て
  //    パネルは空」を解消）。※右パネルのカードは draftObjects があれば常に表示。キャンバスの範囲オーバーレイだけは
  //    showRangeOverlay トグルで任意に表示・非表示できる（＝トグルOFFでもパネルのカードは残る／作図確定時は自動でON）。
  const overlayObjects: AiEditObjectReference[] =
    activeTool === 'area' && showRangeOverlay ? draftObjects : [];

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

  // 画像やタブが変わったらズームを等倍へ戻す（別の画像へ拡大状態を持ち越さない）。
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [baseDisplayUrl, activeTool]);

  // マウスホイールでズーム（カーソル位置中心）。ページスクロールを止めるため非パッシブで直付け（260708）。
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !isOpen) return;
    const onWheel = (e: WheelEvent) => {
      if (!baseDisplayUrl) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const oldZoom = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.min(MAX_ZOOM, Math.max(1, oldZoom * factor));
      if (newZoom === oldZoom) return;
      if (newZoom <= ZOOM_MIN_SNAP) {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        return;
      }
      const oldPan = panRef.current;
      const ratio = newZoom / oldZoom;
      let px = cx - ratio * (cx - oldPan.x);
      let py = cy - ratio * (cy - oldPan.y);
      // 画像がビューポートを覆い続けるようパンをクランプ（余白を出さない）。
      px = Math.min(0, Math.max(rect.width * (1 - newZoom), px));
      py = Math.min(0, Math.max(rect.height * (1 - newZoom), py));
      setZoom(newZoom);
      setPan({ x: px, y: py });
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [baseDisplayUrl, isOpen]);

  useEffect(() => {
    if (isOpen && baseDisplayUrl) {
      setCompareA(baseDisplayUrl);
      setCompareB(baseDisplayUrl);
    }
  }, [isOpen, activeVersionId, baseDisplayUrl]);

  useEffect(() => {
    if (!isOpen) return;
    const hasSituationDraft = draftStyleRefs.length > 0 || draftStyleMemo.trim().length > 0;
    // Keep the card visible once shown; only trash action hides it.
    setIsSituationCardVisible((prev) => prev || hasSituationDraft);
  }, [isOpen, draftStyleRefs, draftStyleMemo]);

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    });

  const onPickStyleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    try {
      const urls = await Promise.all(images.map((f) => readFileAsDataUrl(f)));
      onAddStyleRefs(urls); // 複数対応（260707）。上限は session 側で MAX_STYLE_REFS に丸める。
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

  // 写真専用モード（2a）: アップロード写真をベース画像(v0)として登録。
  // 260703: アップロード直後に「AI対応比率へのクロップ画面」を挟む（構図ズレの根本解決・クライアント合意）。
  //   file→クロップ画面(cropSrc)→確定でクロップ画像を縮小してベース登録。
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const onPickBaseFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    try {
      const url = await readFileAsDataUrl(f);
      setCropSrc(url); // クロップ画面を開く
    } catch {
      /* ignore */
    }
  };
  const handleCropConfirm = async (cropped: string) => {
    setCropSrc(null);
    try {
      const sized = await downscaleDataUrlIfNeeded(cropped, 1536);
      onUploadBaseImage?.(sized);
    } catch {
      /* ignore */
    }
  };

  // 上部左のバー: 通常は 2D/3D/AI のモード切替、写真専用モードでは「ホームに戻る」ボタン（2a）。
  const renderModeBarOrHome = () => (
    <div className="flex items-center gap-2">
      {photoOnly ? (
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
        className="shrink-0"
      />
      )}
      <EditorHelpButton onClick={onOpenGuide} />
    </div>
  );

  const styleImageDataUrls = draftStyleRefs
    .map((u) => normalizeImageDataUrl(u))
    .filter((u): u is string => !!u);
  const hasStyleImages = styleImageDataUrls.length > 0;
  const emptySituationCard =
    activeTool === 'coordinate' &&
    isSituationCardVisible &&
    !hasStyleImages &&
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
  // エリア編集の実行可否は「エリア編集の入力（範囲＋指示）だけ」で判定する。コーディネート欄のプロンプトとは
  // 完全に独立（260702 クライアント指摘: 範囲を1つも作成していなくても、コーディネートに入力があるとボタンが
  // 押せてしまう＝機能が混線している問題の是正）。範囲(placement)が1つ以上・空カードなし・指示ありが条件。
  const canRunAreaEdit = hasAreaEditInput && areaPlacementCount > 0 && emptyCardCount === 0;

  // 確定した1枚を版として登録する（単一候補＝即確定／複数候補＝ピッカーで選んだ1枚）。
  // 比較スライダー・暗黙フィードバック・onEditSuccess をまとめて行う（複数候補でも1回だけ版を作る）。
  const commitEditResult = useCallback(
    (parentId: string, baseImageDataUrl: string, finalUrl: string) => {
      setCompareA(baseImageDataUrl);
      setCompareB(finalUrl);
      setCompareSlider(50);
      // 一つ前に戻って再生成した扱い＝直前の既存子を暗黙 bad として記録（ベストエフォート）。
      const priorChildren = versions.filter((v) => v.parentId === parentId);
      if (priorChildren.length > 0) {
        const abandoned = priorChildren.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        void recordImplicitFeedback('regenerate', {
          verdict: 'bad',
          imageRef: abandoned.id,
          styleMemo: abandoned.styleMemo,
        }).catch((e) => console.warn('[ai feedback] 暗黙的bad評価の記録に失敗', e));
      }
      onEditSuccess({
        parentId,
        baseImageDataUrl,
        outputImageDataUrl: finalUrl,
        styleRefDataUrls: [],
        styleMemo: '',
        objects: draftObjects.map((o) => ({
          ...o,
          placements: o.placements.map((p) => ({ ...p })),
          placementMemos: [...(o.placementMemos ?? [])],
        })),
      });
    },
    [versions, onEditSuccess, draftObjects]
  );

  // 【コスト2段化（point2・260721 クライアント要望）】エリア編集の“後段（仕上げ）”を1関数に集約し、フラグで
  // 走らせる段を切り替えられるようにする。候補（ドラフト）生成では高コストな段（仕上げ Gemini パス・精細化・
  // フリープラン後処理）を回さず素早く・安く複数枚を提示し、ユーザーが1枚を選んだ“本番確定”のときにだけそれらを
  // 通す。本番はドラフト画像“そのもの”を土台にする（元画像から作り直さない）ので、選んだ構図・家具の形はそのまま
  // 保たれる（＝プレビューと本番のズレが出ない）。単一候補は全段 true で従来と完全に同一挙動。
  const applyAreaEditFinish = useCallback(
    async (
      input: string,
      confineBase: string,
      baseScaled: string,
      ctx: AreaEditFinishCtx,
      flags: { runFinishing: boolean; runOpeningRestore: boolean; runEnhance: boolean; runFreePlan: boolean }
    ): Promise<string> => {
      const { baseW, baseH, imageSize, editedHasReplacement, skipFinishFor1B, anyComposited, allPlacements, surfaceOnly, openings } = ctx;
      let outUrl = input;
      // 仕上げパス（naturalize/harmonize）。1-B（面仕上げのみ全画面採用）は継ぎ目が無いので元々回さない。
      if (flags.runFinishing && !skipFinishFor1B) {
        const finalPassBody = editedHasReplacement ? { naturalize: true } : { harmonize: true };
        try {
          const finishBase = await compressDataUrlToBudget(outUrl, { maxBytes: SEND_BASE_MAX_BYTES });
          const hres = await fetch('/api/ai-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
            body: JSON.stringify({ baseImage: finishBase, ...finalPassBody, aspectRatio: pickClosestAspectRatio(baseW, baseH), imageSize }),
          });
          const hdata = await hres.json();
          if (hdata.success && hdata.url) {
            void recordAiUsage({ feature: 'ai_edit', usage: hdata.usage, model: hdata.model, imageCount: 1, projectId: projectSession?.projectId ?? null });
            outUrl = await fitDataUrlToSize(hdata.url as string, baseW, baseH, 'cover');
          }
        } catch {
          /* なじませ失敗は入力（貼り合わせ結果）を採用 */
        }
      }
      // 最終の閉じ込め（範囲外を base へ戻す／開口を除外）。仕上げパスが範囲外へ描いた家具や継ぎ目をここで是正。
      if (anyComposited && allPlacements.length > 0) {
        try {
          const unionFeather = Math.round(Math.max(baseW, baseH) * (surfaceOnly ? 0.012 : 0.008));
          const unionDilate = Math.round(Math.max(baseW, baseH) * 0.015);
          const confined = surfaceOnly
            ? await harmonizeEditToBase(confineBase, outUrl, allPlacements, baseW, baseH, { applyDilatePx: unionDilate })
            : outUrl;
          outUrl = await compositeMaskedEdit(
            confineBase,
            confined,
            allPlacements,
            baseW,
            baseH,
            unionFeather,
            unionDilate,
            openings.length > 0 ? openings : undefined,
            surfaceOnly
          );
        } catch {
          /* 最終閉じ込め失敗は仕上げ結果をそのまま採用 */
        }
      }
      // 1-B の開口復元（面仕上げのみ全画面採用時）。ドラフト生成時に一度実施済みのため、本番確定では再実施しない
      // （runOpeningRestore=false＝冪等な再貼りを省く）。
      if (flags.runOpeningRestore && skipFinishFor1B && openings.length > 0 && baseScaled) {
        const aiFull = outUrl;
        try {
          const openingFeather = Math.round(Math.max(baseW, baseH) * 0.004);
          outUrl = await compositeMaskedEdit(aiFull, baseScaled, openings, baseW, baseH, openingFeather, 0, undefined, false);
        } catch {
          /* 開口復元の失敗は全画面結果を採用 */
        }
      }
      // 画質を高める（精細化・keepQuality）。高コストなので本番確定でのみ。
      if (flags.runEnhance && ENABLE_KEEP_QUALITY_ENHANCE && ctx.keepQuality) {
        try {
          const enhanceBase = await compressDataUrlToBudget(outUrl, { maxBytes: SEND_BASE_MAX_BYTES });
          const eres = await fetch('/api/ai-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
            body: JSON.stringify({ baseImage: enhanceBase, enhanceDetail: true, aspectRatio: pickClosestAspectRatio(baseW, baseH), imageSize }),
          });
          const edata = await eres.json();
          if (edata.success && edata.url) {
            void recordAiUsage({ feature: 'ai_edit', usage: edata.usage, model: edata.model, imageCount: 1, projectId: projectSession?.projectId ?? null });
            outUrl = await fitDataUrlToSize(edata.url as string, baseW, baseH, 'cover');
          }
        } catch {
          /* 精細化失敗は元の結果をそのまま使う */
        }
      }
      // フリープラン出力制限（縮小＋透かし）。本番確定でのみ適用（ドラフトには掛けない）。
      if (flags.runFreePlan) {
        outUrl = await maybeApplyFreePlanOutputLimits(outUrl, ctx.isFreePlan);
      }
      return outUrl;
    },
    [projectSession]
  );

  const runEdit = useCallback(async () => {
    if (!activeVersion) return;
    setSubmitError(null);
    setSubmitWarning(null);
    setIsSubmitting(true);
    try {
      // 土台（base）は従来どおり直近の画像＝連続編集のワークフローを維持する。
      const baseScaled = await downscaleDataUrlIfNeeded(await ensureDataUrl(activeVersion.outputImageDataUrl));
      // 「画質を高める」は 2枚目の見本画像を渡す旧方式を廃止（ゴースト原因・260710）。生成後に現在の1枚だけを
      // 精細化する後処理パス（enhanceDetail）に置換したため、ここでは見本画像を一切用意しない。
      const { w: baseW, h: baseH } = await loadImageNaturalSize(baseScaled);
      const aspectRatio = pickClosestAspectRatio(baseW, baseH);
      // 生成サイズは動作実績のある AIレンダリングと同じプレビュー用(1K)に揃える。2K のままだと新しい画像
      // モデル(gemini-3-pro-image-preview)で生成が途中劣化し「白っぽくぼやけた」出力になる事象があった
      // （AIレンダリングは PREVIEW_GEMINI_IMAGE_SIZE=1K で正常、AIデザイン/編集だけ 2K で異常・260619報告対応）。
      const imageSize = PREVIEW_GEMINI_IMAGE_SIZE;

      // 参照画像は「寸法を2048へ丸め」たうえで「送信サイズ（バイト）予算」まで圧縮する（260718）。
      // 旧実装は downscaleDataUrlIfNeeded で寸法しか丸めず（PNG はロスレスで実バイトが減らない）、2MB級の参照＋base を
      // 1つの body で送ると Vercel の関数上限(~4.5MB)を超えて原因不明の「編集に失敗しました」になっていた。
      // 予算内の画像はそのまま（＝小さい PNG は PNG のまま）、超過時のみ JPEG 化して収める。
      const objectsScaled = await Promise.all(
        draftObjects.map(async (o) => {
          const norm = normalizeImageDataUrl(o.imageDataUrl);
          return {
            ...o,
            imageDataUrl: norm
              ? await compressDataUrlToBudget(await downscaleDataUrlIfNeeded(await ensureDataUrl(norm)), {
                  maxBytes: SEND_REF_MAX_BYTES,
                })
              : null,
          };
        })
      );

      // 【送信ペイロードの事前チェック（Vercel body 上限~4.5MB 対策・差し替え経路・260718）】
      // 各範囲は base+参照1枚を1つの JSON body で送るため、最悪ケース（送信用に圧縮した base＋最大の参照1枚）で概算し、
      // 圧縮後もなお上限を超える場合は、原因不明の失敗ではなく明確なメッセージで止める（コーディネート欄と同じ考え方）。
      // ※通常は上の圧縮で収まるため、これは圧縮しきれない特殊ケースの保険。
      const sentBaseForCheck = await compressDataUrlToBudget(baseScaled, { maxBytes: SEND_BASE_MAX_BYTES });
      const maxRefBytes = objectsScaled.reduce(
        (m, o) => Math.max(m, o.imageDataUrl ? dataUrlTransmitBytes(o.imageDataUrl) : 0),
        0
      );
      if (dataUrlTransmitBytes(sentBaseForCheck) + maxRefBytes > SEND_BODY_MAX_BYTES) {
        setSubmitError('アップロードした画像のサイズが大きすぎます。もう少し小さい画像（目安2MB以下）でお試しください。');
        return; // finally で isSubmitting=false
      }

      // in-context反映（row 211/219）: 個人の高評価傾向＋全体共有プールを取得し、生成プロンプトへ参考添付（ベストエフォート）。
      const learnedHints = await getLearnedHints().catch(() => [] as string[]);

      // エリア編集は「マスク領域だけ」を編集する独立機能（260702 クライアント指摘対応）。コーディネート欄の
      // スタイル/プロンプト（styleImage/styleMemo）は一切読み込まない。マスク領域＋余白をクロップして拡大送信し
      // （重なった家具の分離＝精度向上）、編集後は必ずベースへ貼り戻して多角形/矩形でクリップする。これにより
      // マスク外は常にベースのまま＝指定外は改変されない（＝拘束力の担保）。
      // 生成結果を1つ作る内部関数（同一入力で複数回呼べば別候補になる・Option 1 複数候補・260717）。
      // draftMode=true のときは高コストな仕上げ段を回さず“ドラフト”を返す（複数候補を安く提示・point2）。返り値は
      // 画像URLと、本番確定（applyAreaEditFinish）で再利用する仕上げコンテキスト。
      const produceOne = async (draftMode = false): Promise<{ url: string; ctx: AreaEditFinishCtx }> => {
      // 生成結果（エリア編集は Gemini のみ・範囲ごとにクロップ＋範囲外の閉じ込め）。
      let outUrl: string | null = null;
      // 仕上げ段のコンテキストと戻し先（Gemini 経路の内側で確定するため外側に控える・point2）。
      let finishCtx: AreaEditFinishCtx | null = null;
      let confineBaseForFinish = '';

      // === Gemini 経路 ===
      if (outUrl == null) {
      // 生成前の事前解析（対象の説明 narratives・260709）。クロップ経路の出し分けは被覆率（幾何・isConfinedRegion）で
      // 決めるようになった（260711）ので、この解析は「どの対象を編集するか」の特定補助に使う（遮蔽判定は今は使わない）。
      // narratives は生成本体へ渡して再解析を省く（二重解析回避）。解析失敗は narratives 無しで続行。
      let narratives: Record<string, string> = {};
      // 各対象が手前の家具に隠れているか（遮蔽）。遮蔽対象を「先に・単独編集相当のフォーカスクロップ」で処理するため（260715）。
      let occludedMap: Record<string, boolean> = {};
      // 面仕上げ（壁/床/天井）の内側に検出した窓・ドア等の開口（objectId→正規化矩形・260718 case B）。
      // 面全体を一様に塗らせ（塗り残しゼロ・③）、検出した開口だけを合成で除外＝元のまま保持する。
      let openingsMap: Record<string, NormalizedRect[]> = {};
      try {
        // 事前解析は /api/ai-edit に analyze:true で相乗り（Hobbyプランのサーバレス関数数上限=12 対策・専用
        // エンドポイントを増やさない・260709）。遮蔽判定はベース画像＋範囲（座標）だけで足りるので、参照画像
        // (imageDataUrl)は外して送る（Vercel body 上限に対する payload 削減）。
        const ares = await fetch('/api/ai-edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
          body: JSON.stringify({
            analyze: true,
            baseImage: sentBaseForCheck, // 圧縮済みの base（解析は視覚判断なので JPEG 化で十分・payload 削減）
            objects: objectsScaled.map((o) => ({ ...o, imageDataUrl: null })),
          }),
        });
        const adata = await ares.json();
        if (adata?.success) {
          narratives = adata.narratives ?? {};
          occludedMap = adata.occluded ?? {};
          openingsMap = (adata.openings ?? {}) as Record<string, NormalizedRect[]>;
        }
      } catch {
        /* 解析失敗は非クロップ（自然）で続行 */
      }

      // 【範囲ごとに個別処理（260714・クライアント選択の方式B）】複数範囲＋複数画像を一度に渡すと、どの画像を
      // どの範囲へ入れるかをモデルが自己判断し「入れ替わり」が起きる。そこで範囲を1つずつ、その範囲＋その1枚だけを
      // 渡して順に編集し（渡す画像が1枚なので入れ替わり不可）、直前の結果へ貼り戻す（範囲外は保持）。最後に継ぎ目をなじませる。
      // 【文脈クロップは全範囲で共有】各範囲を個別に小さくクロップして送ると、モデルは部屋全体の文脈を失い、参照画像の
      // 対象を「置く／差し替える」べき場面を誤判断する（空きスペースへ椅子を置くべき所で対象なしと判断して消す・
      // テーブルを無変化で返す＝260714 クライアント報告）。旧・単一呼び出しは全範囲(union)の外接矩形でクロップして
      // 全体文脈を保っていた。範囲ごと個別化してもクロップは全範囲基準(sharedCropPx)を共有し、各呼び出しで絞るのは
      // 「送る参照画像＋フォーカス範囲＝1つずつ」だけにする（入れ替わりは画像1枚化で防止・文脈は全範囲クロップで確保）。
      // bbox（正規化外接矩形）→ 送信用クロップ（局所なら範囲＋余白、そうでなければ null=全画面）を作る共通ヘルパ。
      // 全範囲共有クロップにも、遮蔽対象の“単独編集相当”フォーカスクロップ（その対象だけ）にも使う。
      const cropForBBox = (bbox: ReturnType<typeof unionBBoxOfPlacements> | null): CropPx | null => {
        if (!bbox || !isConfinedRegion(bbox)) return null;
        const padded = padBBox(bbox);
        const targetAspect = parseAspectRatioKey(
          pickClosestAspectRatio(Math.max(1, Math.round(padded.w * baseW)), Math.max(1, Math.round(padded.h * baseH)))
        );
        const candidate = snapCropToAspect(padded, baseW, baseH, targetAspect);
        return shouldCropRegion(padded, candidate, baseW, baseH) ? candidate : null;
      };
      const allPlacements = objectsScaled.flatMap((o) => o.placements);
      const unionBBox = allPlacements.length > 0 ? unionBBoxOfPlacements(allPlacements) : null;
      const sharedCropPx: CropPx | null = cropForBBox(unionBBox);
      // 【面仕上げのみの編集か（260720・境界線対策 point1-A）】全対象が面仕上げ（壁/床/天井）のときだけ、合成の
      // フェザーを両側（外側にも）掛けて境界のすぐ外側の硬い縁を溶かす。家具差し替えを含むと外側フェザーで元家具の
      // ゴースト二重縁が出るため、混在時は従来どおり内側限定に留める（安全側）。
      const surfaceOnly = objectsScaled.length > 0 && objectsScaled.every((o) => isSurfacePlaneFinish(o));

      // editOneRegion: base に対して1領域 o を Gemini で編集し、範囲外を base のまま保った全画像を返す（失敗は null）。
      const editOneRegion = async (
        base: string,
        o: (typeof objectsScaled)[number],
        multiRegion: boolean,
        isOccluded: boolean
      ): Promise<{ url: string; composited: boolean } | null> => {
        // この範囲の編集で throw が起きても（ネットワーク/JSON/canvas 等）他範囲を巻き込まずスキップできるよう
        // 本体全体を try で囲み、失敗は null を返す（呼び出し側のループは null を飛ばして次の範囲へ進む）。
        try {
          const objBBox = o.placements.length > 0 ? unionBBoxOfPlacements(o.placements) : null;
          if (!objBBox) return null;
          const objCoverage = objBBox.w * objBBox.h;
          const objIsGlobal = objCoverage >= GLOBAL_REGION_COVERAGE;
          // クロップ選択:
          // ・遮蔽対象（isOccluded）: その対象“だけ”に絞ったフォーカスクロップ（＝単独編集と同じ見え方）。奥に隠れた
          //   対象を全範囲の広いクロップで送ると、部屋全体の中で見失い別位置へ複製されやすい（単独なら正確に差し替わる
          //   ＝クロップが対象に絞られているから・260715 report）。対象が小さすぎ/大きすぎてフォーカスクロップを作れない
          //   ときは全画面ではなく sharedCropPx（全範囲クロップ）へフォールバック＝少なくとも従来（変更前）より広げない。
          // ・それ以外: 全範囲共有（sharedCropPx）＝部屋全体の文脈で送る（空きスペースへの配置等の誤判断を防ぐ）。
          // 【面仕上げ（壁面緑化/タイル/塗装/天井造作 等）はクロップしない（Path A・260717）】クロップ→拡大→再生成すると
          // 面の形・エッジが崩れ、境界で床色が変わる（④）。全画面のまま生成すれば面の形状が部屋全体の遠近で固定され、
          // 面全体を見て塗り残しなく仕上げやすい（③）。家具の生地張り替えや差し替えは従来どおりクロップで寄る。
          const isSurface = isSurfacePlaneFinish(o);
          const cropPx = isSurface ? null : isOccluded ? cropForBBox(objBBox) ?? sharedCropPx : sharedCropPx;
          // 【面の開口保持（case B・260718 → 監査対応 F1/F4）】検出した窓・ドア等の開口は、合成でマスクから除外＝元のまま
          // 保持する。モデルには面全体を一様に塗らせ（塗り残しゼロ・③）、開口だけ決定論的に元へ戻す。
          // F1: 除外の発火は「開口が検出されたか」で判定する（isSurfacePlaneFinish 依存をやめる）。開口検出は解析モデルが
          // 「フォーカスが壁/床/天井の面か」を視覚判断して行い、RE_SURFACE(語彙)とは別基準。例:「壁を白く塗る」は RE_SURFACE
          // に載らない（塗る は家具誤爆回避で除外）が窓は検出される→従来は除外されず塗り潰されていた。検出有無で揃える。
          // F4: 開口をこの面自身の placements 外接矩形へクリップ（隣の面へ穴を空けない・はみ出し/交差なしは除去）。
          // R2-1: 面のほとんどを覆う非現実的な検出（誤検出）は丸ごと落として、面全体が未仕上げになる最悪ケースを防ぐ。
          // フラグ OFF なら決定論の開口除外を止め、プロンプトのみ（一様塗り＋見える窓のソフト保持）で対応する。
          // 検出開口はクリップ→面積バックストップ→幾何フィルタ（天井際コーブ等の誤検出除去・260720）を一本化して健全化。
          const detectedOpenings = ENABLE_OPENING_PRESERVE ? openingsMap[o.id] : undefined;
          const clippedOpenings = sanitizeDetectedOpenings(detectedOpenings, o.placements);
          const excludeRects = clippedOpenings.length > 0 ? clippedOpenings : undefined;
          // 【合成マスクは「描いた範囲そのもの（o.placements）」で統一（260715 report: 横一直線の継ぎ目）】
          // 以前は差し替えで範囲を pad で上下左右へ広げた矩形(thisKeep)を採っていたが、背の高い家具では“上方向の pad”が
          // 家具の上の壁・窓まで採り込み、その上端が横一直線の継ぎ目として見えていた（複数家具の上端が揃うと画面幅の横線）。
          // 差し替え対象は「範囲内に収める」方針なので、描いた範囲そのもので過不足なく、壁・窓へ余分にはみ出さない。
          // 多角形は形どおり・矩形はそのまま・複数 placement の“間”も base のまま（範囲外は変わらない）。
          // クロップ経路ではベース・配置座標・アスペクト比をクロップ空間に統一。渡す objects はこの1領域だけ（入れ替わり防止）。
          const postBase = cropPx ? await cropDataUrl(base, cropPx) : base;
          // 送信用 base を予算内へ圧縮（Vercel body 上限対策・260718）。合成には呼び出し元の base（元画像）を使うので、
          // 送信を JPEG 化しても未編集域の画質・連鎖編集の劣化には影響しない（マスク内はどのみち生成し直される）。
          const sentBase = await compressDataUrlToBudget(postBase, { maxBytes: SEND_BASE_MAX_BYTES });
          const postObjects = cropPx
            ? [{ ...o, placements: remapPlacementsToCrop(o.placements, cropPx, baseW, baseH) }]
            : [o];
          const postAspect = cropPx ? pickClosestAspectRatio(cropPx.sw, cropPx.sh) : aspectRatio;
          const body: Record<string, unknown> = {
            baseImage: sentBase,
            objects: postObjects,
            aspectRatio: postAspect,
            imageSize,
            learnedHints,
            // 複数範囲では最終的にこの範囲マスクだけを採用するため、モデルにも「この範囲だけ触る」よう常に指示する。
            // 1-B（面仕上げのみを全画面採用）では合成でポリゴン外を保護しない分、モデル側の「この範囲だけ触る」指示を
            // 常に強制して家具・床・他壁の描き替え（drift）を最大限抑止する（260720）。
            strictConfine:
              (surfaceOnly && ENABLE_AREA_EDIT_SURFACE_FULLFRAME) || !!cropPx || !objIsGlobal || multiRegion,
            ...(narratives[o.id] ? { placementNarratives: { [o.id]: narratives[o.id] } } : {}),
          };
          const res = await fetch('/api/ai-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!data.success || !data.url) return null;
          void recordAiUsage({ feature: 'ai_edit', usage: data.usage, model: data.model, imageCount: 1, projectId: projectSession?.projectId ?? null });
          const feather = Math.round(Math.max(baseW, baseH) * 0.008);
          const dilate = Math.round(Math.max(baseW, baseH) * 0.01);
          if (cropPx) {
            const fittedCrop = await fitDataUrlToSize(data.url as string, cropPx.sw, cropPx.sh, 'cover');
            const full = await pasteCropIntoBase(base, fittedCrop, cropPx, baseW, baseH);
            // 合成マスクは「描いた範囲(o.placements)」で閉じ込める（差し替え・テキスト・削除すべて共通）。クロップは
            // 送っているので文脈は担保・マスク外は base（範囲外は変わらない＝近くの似た家具や壁も保護・上の壁への横線も出ない）。
            // ゲイン補正の適用域を合成の貼り込み域（dilate ぶん膨張）に合わせる＝境界外側の未補正リングを無くす（260720）。
            const matched = await harmonizeEditToBase(base, full, o.placements, baseW, baseH, { applyDilatePx: dilate });
            // 複数範囲でも少しだけ dilate して合成する＝隣接する範囲どうしの境界に base の細い帯（白線）が
            // 残らないようにする（②・260717）。単一範囲は従来どおり dilate（接地影を少し残す）。
            // 面仕上げ(isSurface)は featherOutside=true で両側フェザー＝囲み外側の硬い境界線を溶かす（point1-A・260720）。
            return {
              url: await compositeMaskedEdit(base, matched, o.placements, baseW, baseH, feather, dilate, excludeRects, isSurface),
              composited: true,
            };
          }
          // 全画面生成（大領域／範囲がバラけて全範囲クロップが効かない）: base 寸法へ整える。
          const { w: gemW, h: gemH } = await loadImageNaturalSize(data.url as string);
          const isBounded = !objIsGlobal;
          // 複数範囲では cover 固定でレターボックスを避ける（座標整合）。
          const mode: 'cover' | 'contain' =
            !multiRegion && !isBounded && coverCropLossFraction(gemW / gemH, baseW / baseH) > 0.1 ? 'contain' : 'cover';
          const fitted = await fitDataUrlToSize(data.url as string, baseW, baseH, mode);
          // 【1-B（260720 クライアント要望）】面仕上げのみの編集は、ここでポリゴン合成せず全画面をそのまま採用する
          // ＝囲みのすぐ外側に境界線（継ぎ目）を構造的に作らない。モデルは画像“全体”を coherent に再生成しており、
          // 対象面以外（家具・床・他壁）は strictConfine＋プロンプトで保持指示済み。窓・ドアの原画復元は最終段でまとめて
          // 行う（開口だけの復元＝ポリゴン境界の継ぎ目が出ない）。contain の黒帯は避けて cover で返す。
          if (surfaceOnly && ENABLE_AREA_EDIT_SURFACE_FULLFRAME) {
            const fullFrame =
              mode === 'contain' ? await fitDataUrlToSize(data.url as string, baseW, baseH, 'cover') : fitted;
            return { url: fullFrame, composited: false };
          }
          // 【面仕上げで検出開口があるときは必ず合成する（case B・260718）】被覆率が高い（囲みがほぼ全画面）と
          // shouldCompositeAreaEdit は false（＝全画面直で継ぎ目なし）を返す。しかし面仕上げで窓・ドアの開口を検出して
          // いる場合、合成を飛ばすと開口をマスクから除外できず窓・ドアが仕上げで塗り潰されたまま残る（③の窓・ドア回帰）。
          // 壁いっぱいに囲む＝高被覆こそ本ケースの典型なので、除外すべき開口があるときは被覆率に関わらず合成経路へ回す。
          const mustExcludeOpenings = !!excludeRects && excludeRects.length > 0;
          // 全画面経路も合成マスクは o.placements（描いた範囲）で統一。複数範囲は常に閉じ込め、単一は被覆率で判定
          // （contain は multiRegion では発生しない＝mode は multiRegion で cover 固定のため旧 contain 早期returnは不要）。
          if (multiRegion || mustExcludeOpenings || shouldCompositeAreaEdit({ placementCount: o.placements.length, fitMode: mode, unionCoverage: objCoverage })) {
            // 【合成するなら contain（レターボックス）は使わない（R2-2・260718 監査対応）】mode==='contain' の fitted は黒帯付き。
            // 合成マスク(o.placements)・excludeRects は base 座標系なので、シフトしたレターボックス画像を合成すると壁の中に黒帯や
            // 位置ズレが混入する（shouldCompositeAreaEdit が fitMode!=='cover' で合成しないのは元々このため）。mustExcludeOpenings で
            // 合成を強制するときはここで cover に取り直して base と座標を揃える（端がわずかに切れるが黒帯より良い＝非合成経路と同方針）。
            const compFitted =
              mode === 'contain' ? await fitDataUrlToSize(data.url as string, baseW, baseH, 'cover') : fitted;
            // ゲイン補正の適用域を合成の貼り込み域（dilate 膨張）に合わせて境界外側の未補正リングを無くす（260720）。
            const matched = await harmonizeEditToBase(base, compFitted, o.placements, baseW, baseH, { applyDilatePx: dilate });
            // 複数範囲でも dilate を効かせ、隣接範囲の境界に base の白線が残るのを防ぐ（②・260717。従来は multiRegion で 0）。
            // 面仕上げは検出した開口(excludeRects)をマスクから除外＝窓・ドアを元のまま保持する（case B・260718）。
            // 面仕上げ(isSurface)は featherOutside=true で両側フェザー＝囲み外側の硬い境界線を溶かす（point1-A・260720）。
            return {
              url: await compositeMaskedEdit(base, matched, o.placements, baseW, baseH, feather, dilate, excludeRects, isSurface),
              composited: true,
            };
          }
          // ここは「単一・実質全画面（被覆≥0.85）＝合成せず全画面採用」のケース。contain のままだと最終出力に黒帯
          // （レターボックス）が残るため、黒帯を避けて cover で返す（端がわずかに切れるが黒帯より良い・260715 監査対応）。
          return {
            url: mode === 'contain' ? await fitDataUrlToSize(data.url as string, baseW, baseH, 'cover') : fitted,
            composited: false,
          };
        } catch {
          // この範囲の編集失敗は他範囲を巻き込まずスキップ（null）。
          return null;
        }
      };

      // 範囲を1つずつ順に編集（各回に渡す参照画像は1枚だけ＝入れ替わり不可）。直前の結果を土台に次の範囲を編集する。
      // 【遮蔽対象を先に処理（260715 クライアント提案）】奥に隠れた対象は、他の差し替えが入る前のきれいな土台に対して、
      // その対象だけに絞ったフォーカスクロップ（＝単独編集と同じ）で先に差し替えると正確（「単独なら正確に差し替わる」
      // の再現）。その後で遮蔽なしの対象を処理する。安定ソート（同順位は元の並び）で遮蔽=先頭へ。
      // 「複数範囲」= 編集する“範囲（placement）”が2つ以上（オブジェクト数ではない）。1つのエリアに複数範囲を追加した
      // 場合（例: 窓を2箇所）も含める＝各範囲へ厳密に閉じ込め（o.placements）、範囲外（窓と窓の間の壁等）は base の
      // まま保つ。オブジェクト数で判定していたときは、1エリア複数範囲が“単一”扱いになり、全範囲を含む広いクロップ矩形
      // ([cropRect]) を丸ごと再生成→範囲外まで作り替え＋クロップ端に継ぎ目（窓の左に縦線）が出ていた（260715 report）。
      const multiRegion = objectsScaled.reduce((n, o) => n + o.placements.length, 0) > 1;
      const processOrder = [...objectsScaled].sort(
        (a, b) => (occludedMap[a.id] ? 0 : 1) - (occludedMap[b.id] ? 0 : 1)
      );
      let workingBase = baseScaled;
      let editedCount = 0;
      let editedRegions = 0; // 編集に成功した“範囲（placement）”の総数。最終仕上げの発火判定に使う（オブジェクト数ではなく範囲数）。
      let editedHasReplacement = false; // 実際に成功した編集の中に「差し替え（参照画像あり）」が含まれるか＝最終パスの種類選択に使う。
      let failedCount = 0; // 失敗（null）したエリアの数。1件でも成功したうえで一部失敗したら警告を出す（無言失敗の可視化・260715 監査対応）。
      let anyComposited = false; // 1範囲でも「合成マスクで閉じ込め」たか。true のとき最終仕上げも範囲外へ閉じ込める（①②・260717）。
      for (const o of processOrder) {
        const r = await editOneRegion(workingBase, o, multiRegion, !!occludedMap[o.id]);
        if (r) {
          workingBase = r.url;
          if (r.composited) anyComposited = true;
          editedCount += 1;
          editedRegions += o.placements.length;
          if (o.imageDataUrl) editedHasReplacement = true;
        } else {
          failedCount += 1;
        }
      }
      if (editedCount === 0) throw new Error('編集に失敗しました。しばらくして再度お試しください。');
      // 一部だけ成功したとき（全滅は上で throw 済み）は、結果は反映しつつ「どれだけ反映できなかったか」を警告表示。
      if (failedCount > 0) {
        setSubmitWarning(
          `${objectsScaled.length}件中${failedCount}件のエリアは今回反映できませんでした（他は反映済み）。反映されなかったエリアはもう一度お試しください。`
        );
      }
      outUrl = workingBase;
      // 仕上げパス（naturalize/harmonize）を通す前の貼り合わせ結果を控える（R2-3・260718 監査対応）。最終の union 閉じ込めで
      // 「範囲外＝base に戻す／開口＝元へ戻す」の“戻し先”はこれを使う。baseScaled（原画）だと、面の窓の手前に置いた家具
      // （別範囲の差し替え）が開口の穴あけで原画に戻され、せっかく置いた家具が消える。仕上げ前の workingBase は
      // 「範囲外＝base・面の窓＝base・窓の手前の家具＝家具」を既に正しく含むため、戻し先として正しい。
      confineBaseForFinish = workingBase;
      // 【1-B】面仕上げのみの全画面採用では貼り合わせ＝継ぎ目が無いため、仕上げ（継ぎ目消し）パスは不要
      // （後段 applyAreaEditFinish 内で skipFinishFor1B により自動スキップ）。
      const skipFinishFor1B = surfaceOnly && ENABLE_AREA_EDIT_SURFACE_FULLFRAME;
      // 検出開口（窓・ドア）は union 閉じ込めの excludeRects と 1-B 開口復元の両方で使う（クリップ→面積→幾何で健全化・260720）。
      const openings = ENABLE_OPENING_PRESERVE
        ? objectsScaled.flatMap((o) => sanitizeDetectedOpenings(openingsMap[o.id], o.placements))
        : [];
      // 仕上げ段（naturalize/harmonize → union 閉じ込め → 1-B 開口復元 → 精細化 → フリープラン後処理）に渡すコンテキストを確定。
      // 実行は Gemini 経路を抜けた後の applyAreaEditFinish で行う。ドラフト（候補）は高コスト段を回さず、本番確定でのみ通す（point2）。
      finishCtx = {
        baseW,
        baseH,
        imageSize,
        editedHasReplacement,
        skipFinishFor1B,
        anyComposited,
        allPlacements,
        surfaceOnly,
        openings,
        keepQuality,
        isFreePlan,
      };
      } // === Gemini 経路ここまで（if (outUrl == null)）===

      // Gemini から結果を得られなかった場合の保険（通常は上で outUrl が設定される）。
      if (outUrl == null || finishCtx == null) {
        throw new Error('編集に失敗しました。しばらくして再度お試しください。');
      }
      // 仕上げ段を実行（point2・260721）。draftMode=true（候補生成）は高コスト段（仕上げ Gemini・精細化・フリープラン後処理）を
      // 回さず素早く安く提示し、ユーザーが1枚選んだ“本番確定”でのみ通す。1-B 開口復元はドラフト時に実施済みなので本番確定側は
      // 再実施しない（handleSelectCandidate で runOpeningRestore=false）。生成側（ここ）は常に true。
      outUrl = await applyAreaEditFinish(outUrl, confineBaseForFinish, baseScaled, finishCtx, {
        runFinishing: !draftMode,
        runOpeningRestore: true,
        runEnhance: !draftMode,
        runFreePlan: !draftMode,
      });
      return { url: outUrl, ctx: finishCtx };
      }; // === produceOne ここまで ===

      // 【複数候補から選ぶ（Option 1・260717 クライアント要望）】candidateCount>1 のとき同一入力で複数回生成し、
      // ユーザーが最良の1枚を選ぶ（AI生成のばらつきを味方につける＝③④の“当たり外れ”対策）。1のときは従来どおり即確定。
      const count = Math.min(3, Math.max(1, Math.round(candidateCount)));
      setGenProgress({ total: count, done: [] }); // オーバーレイに進捗（N/total・サムネ）を出す（point3・260720）。
      if (count <= 1) {
        // 単一候補は従来どおり全段実行（本番品質）＝挙動不変。
        const only = await produceOne(false);
        setGenProgress({ total: 1, done: [only.url] });
        commitEditResult(activeVersion.id, activeVersion.outputImageDataUrl, only.url);
      } else {
        // 【コスト2段化（point2・260721）】複数候補は“ドラフト”（高コストな仕上げ段を省いて安く速く）で生成し、
        // ユーザーが選んだ1枚だけ“本番確定”（applyAreaEditFinish 全段）を通す＝3枚ぶんの仕上げ/精細化を1枚に集約してコスト削減。
        const drafts: { url: string; ctx: AreaEditFinishCtx }[] = [];
        let lastErr: unknown = null;
        for (let i = 0; i < count; i++) {
          try {
            const r = await produceOne(true);
            drafts.push(r);
            // 完了した候補を即オーバーレイへ反映（届いた順にサムネ表示＝進捗が見える・point3）。
            setGenProgress({ total: count, done: drafts.map((d) => d.url) });
          } catch (e) {
            lastErr = e; // 一部候補の失敗は許容（他が出れば選べる）。全滅なら下で throw。
          }
        }
        if (drafts.length === 0) {
          throw lastErr instanceof Error ? lastErr : new Error('編集に失敗しました。しばらくして再度お試しください。');
        }
        if (drafts.length === 1) {
          // 1つしか生成できなかった＝選ぶまでもなく確定。ドラフトは仕上げ未実施なので、ここで本番確定を通してから確定する。
          const d = drafts[0];
          let finalUrl = d.url;
          try {
            finalUrl = await applyAreaEditFinish(d.url, d.url, '', d.ctx, {
              runFinishing: true,
              runOpeningRestore: false, // 1-B 開口復元はドラフト時に実施済み（二重貼り回避）。
              runEnhance: true,
              runFreePlan: true,
            });
          } catch {
            /* 本番確定に失敗してもドラフトを採用（フェイルソフト） */
          }
          commitEditResult(activeVersion.id, activeVersion.outputImageDataUrl, finalUrl);
        } else {
          // 候補ピッカーを開く。採用（選択）時に本番確定（applyAreaEditFinish 全段）を通してから版を1つだけ作る（それまで版は作らない）。
          setCandidatePick({
            parentId: activeVersion.id,
            baseImageDataUrl: activeVersion.outputImageDataUrl,
            candidates: drafts,
          });
        }
      }
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'エラー');
    } finally {
      setIsSubmitting(false);
      setGenProgress(null); // 進捗表示を片付ける（オーバーレイは isSubmitting で閉じるが状態も戻す）。
    }
  }, [activeVersion, versions, draftObjects, onEditSuccess, isFreePlan, projectSession, harmonizeSeams, keepQuality, candidateCount, commitEditResult, applyAreaEditFinish]);

  // 候補ピッカーで1枚選んだときの“本番確定”（point2・260721）: 選ばれたドラフトそのものを土台に、仕上げ Gemini パス・
  // 精細化・フリープラン後処理を通してから版を作る。ドラフト画像を土台にするので、選んだ構図・家具の形はそのまま保たれる
  // （元画像から作り直さない＝プレビューと本番のズレが出ない）。失敗時はドラフトを採用（フェイルソフト）。
  const handleSelectCandidate = useCallback(
    async (draft: { url: string; ctx: AreaEditFinishCtx }) => {
      if (!candidatePick || finalizingCandidate) return;
      const { parentId, baseImageDataUrl } = candidatePick;
      setFinalizingCandidate(true);
      let finalUrl = draft.url;
      try {
        finalUrl = await applyAreaEditFinish(draft.url, draft.url, '', draft.ctx, {
          runFinishing: true,
          runOpeningRestore: false, // 1-B 開口復元はドラフト時に実施済み（二重貼り回避）。
          runEnhance: true,
          runFreePlan: true,
        });
      } catch {
        /* 本番確定に失敗してもドラフトを採用（生成結果を失わない） */
      }
      commitEditResult(parentId, baseImageDataUrl, finalUrl);
      setFinalizingCandidate(false);
      setCandidatePick(null);
    },
    [candidatePick, finalizingCandidate, applyAreaEditFinish, commitEditResult]
  );

  const handleClickExecute = () => {
    if (!activeVersion || isSubmitting) return;
    if (emptyCardCount > 0) {
      setSubmitError(`未入力カードがあります（未入力${emptyCardCount}件）`);
      return;
    }
    if (!hasAreaEditInput) {
      setSubmitError('エリア編集で、範囲に加える編集内容（テキストまたは参照画像）を設定してください。');
      return;
    }
    if (areaPlacementCount === 0) {
      setSubmitError('エリア編集を使う場合は、範囲を1つ以上作成してください。');
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
      // コーディネートは「空間全体（お任せ／プロンプト反映）」の独立機能。エリア編集の範囲(draftObjects)は一切
      // 読み込まない（objects:[] 固定・マスクもしない）。プロンプト/参照画像があれば全体スタイル編集として反映し、
      // 無ければ完全お任せ（coordinate:true）。生成サイズは 1K（2Kは新画像モデルでぼやけ・260619報告対応）。
      const styleMemo = draftStyleMemo.trim();
      // スタイル参照は複数対応（260707）。各画像を控えめ（長辺1280）に縮小して配列で送る（複数でも Vercel の
      // body 上限を超えないように。スタイル参照は「雰囲気の手がかり」なので高解像は不要）。
      // スタイル参照は長辺1280へ縮小のうえ、送信サイズ（バイト）予算まで圧縮する（PNGでも実バイトを確実に減らす・260718 監査V2）。
      const styleScaledList = await Promise.all(
        styleImageDataUrls.map(async (u) =>
          compressDataUrlToBudget(await downscaleDataUrlIfNeeded(await ensureDataUrl(u), 1280), {
            maxBytes: SEND_REF_MAX_BYTES,
          }),
        ),
      );
      // 送信用 base も予算内へ圧縮（コーディネートは全体生成でマスク合成しないため、送信のJPEG化は生成し直される出力に影響しない）。
      const sentBase = await compressDataUrlToBudget(baseScaled, { maxBytes: SEND_BASE_MAX_BYTES });
      // 添付が多い/大きいと Vercel の body 上限(~4.5MB)を超えて不明瞭なエラーになるため、送信前に合計サイズを概算して止める。
      // サイズは「送信される base64 文字数」で測る（旧実装は decode 後バイト=len*3/4 で見ており 4/3 だけ過小評価していた・監査V2）。
      const totalBytes =
        dataUrlTransmitBytes(sentBase) + styleScaledList.reduce((s, u) => s + dataUrlTransmitBytes(u), 0);
      if (totalBytes > SEND_BODY_MAX_BYTES) {
        setSubmitError('添付画像の合計サイズが大きすぎます。枚数を減らすか、小さめの画像でお試しください。');
        setIsSubmitting(false);
        return;
      }
      const hasPrompt = styleMemo.length > 0 || styleScaledList.length > 0;
      const body: Record<string, unknown> = hasPrompt
        ? {
            baseImage: sentBase,
            styleImages: styleScaledList,
            objects: [],
            aspectRatio,
            imageSize: PREVIEW_GEMINI_IMAGE_SIZE,
            learnedHints,
            ...(styleMemo ? { styleMemo } : {}),
          }
        : { baseImage: sentBase, coordinate: true, aspectRatio, imageSize: PREVIEW_GEMINI_IMAGE_SIZE, learnedHints };
      const res = await fetch('/api/ai-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify(body),
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
        styleRefDataUrls: styleImageDataUrls,
        styleMemo,
        objects: [],
      });
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'エラー');
    } finally {
      setIsSubmitting(false);
    }
  }, [activeVersion, isSubmitting, versions, onEditSuccess, isFreePlan, projectSession, draftStyleMemo, styleImageDataUrls]);

  // コーディネートタブの実行（260624/260702）: 常に runCoordinate（全体編集）で実行する。エリア編集(runEdit)とは
  // 完全に独立させ、エリア編集の範囲を読み込まない。プロンプト/添付があれば全体スタイル編集、無ければ完全お任せ。
  // プロンプト未入力でも実行可能（クライアント要望）。
  const handleCoordinateExecute = () => {
    if (!activeVersion || isSubmitting) return;
    const creditMsg = creditBlockMessage(projectSession?.aiCredits);
    if (creditMsg) {
      setSubmitError(creditMsg);
      return;
    }
    setSubmitError(null);
    void runCoordinate();
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
    // 描いた範囲が消えないよう、範囲表示がOFFなら自動でONに戻す（260708・トグルOFF中の作図で確定後に見えなくなる不整合の解消）。
    setShowRangeOverlay(true);
    onCommitPlacementRect(activeObjectId, rect);
    setPolygonPoints([]);
    setPolygonCursor(null);
  }, [activeObjectId, polygonPoints, onCommitPlacementRect]);

  const cancelPolygon = useCallback(() => {
    setPolygonPoints([]);
    setPolygonCursor(null);
  }, []);

  // 作図対象（オブジェクト）やマスク方式、表示中バージョンを切り替えたら、作図中の多角形は破棄する
  // （バージョン切替時に作図中の線が新しい結果画像に残らないようにする・260702）。
  useEffect(() => {
    setPolygonPoints([]);
    setPolygonCursor(null);
  }, [activeObjectId, maskMode, activeVersion?.id]);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // 拡大中のパン（移動）。等倍のときは何もしない＝作図（onMouseDownPlacement）に委ねる（260708）。
  const onCanvasPanStart = (e: React.MouseEvent) => {
    if (zoomRef.current <= 1) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPan = panRef.current;
    const onMove = (me: MouseEvent) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const z = zoomRef.current;
      let px = startPan.x + (me.clientX - startX);
      let py = startPan.y + (me.clientY - startY);
      px = Math.min(0, Math.max(rect.width * (1 - z), px));
      py = Math.min(0, Math.max(rect.height * (1 - z), py));
      setPan({ x: px, y: py });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onMouseDownPlacement = (e: React.MouseEvent) => {
    if (zoomRef.current > 1) return; // 拡大中は作図しない（表示専用ズーム・260708）
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
    if (zoomRef.current > 1) return; // 拡大中は作図しない（表示専用ズーム・260708）
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
    if (zoomRef.current > 1) return; // 拡大中は作図しない（表示専用ズーム・260708）
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
    // 描いた範囲が消えないよう、範囲表示がOFFなら自動でONに戻す（260708・矩形ドラッグ確定時も同様）。
    setShowRangeOverlay(true);
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
        {/* アップロード直後のクロップ画面（AI対応比率へ・構図ズレ根本解決・260703）。
            空状態（activeVersion なし）でも写真アップロードはここから始まるため、このブランチにも配置する。 */}
        {cropSrc && (
          <ImageCropDialog
            imageDataUrl={cropSrc}
            onConfirm={handleCropConfirm}
            onCancel={() => setCropSrc(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[10000] flex flex-col bg-zinc-950 text-white pl-3 pr-0 pt-0 pb-0 gap-3">
      {/* アップロード直後のクロップ画面（AI対応比率へ・構図ズレ根本解決・260703）。 */}
      {cropSrc && (
        <ImageCropDialog
          imageDataUrl={cropSrc}
          onConfirm={handleCropConfirm}
          onCancel={() => setCropSrc(null)}
        />
      )}
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
                    {/* 各履歴のプロンプト（指示文）を表示（260708 クライアント要望「範囲と画像、プロンプト」の履歴化）。
                        エリア編集は各領域の指示(memo)を、コーディネートは styleMemo を表示。無ければ控えめな既定文。 */}
                    <div className="text-[9px] text-neutral-500 truncate" title={
                      (v.objects ?? []).map((o) => o?.memo?.trim?.()).filter(Boolean).join(' / ') ||
                      (v.styleMemo?.trim?.() ?? '')
                    }>
                      {(v.objects ?? []).map((o) => o?.memo?.trim?.()).filter(Boolean).join(' / ') ||
                        v.styleMemo?.trim?.() ||
                        '指示なし'}
                    </div>
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
                        v.feedback === 'good'
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
                        v.feedback === 'bad'
                          ? 'bg-rose-500 text-white'
                          : 'text-neutral-400 hover:scale-110 hover:bg-rose-500/20 hover:text-rose-300'
                      }`}
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                    </button>
                    {/* 削除（任意・安全版260630・クライアント要望）: 親子関係に依らず、どの画像でも削除できる。
                        削除しても子は親へ繋ぎ替えられ、子の「元画像」は保持されるため壊れない（useAiEditSession.deleteVersion）。 */}
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
                        // 評価は版に保存しているため、版の削除で自動的に消える（別途の掃除は不要・260707）。
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
                {/* マスク方式の切替（多角形/矩形）はエリア編集パネル上部へ移動（260630・クライアントUI準拠）。
                    描画中の「確定/取消」だけはキャンバス側に残す（その場の操作のため）。 */}
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
              onMouseDown={onCanvasPanStart}
              className={`flex-1 relative rounded-xl border border-white/10 bg-black overflow-hidden min-h-[200px] ${
                zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''
              }`}
            >
              {baseDisplayUrl ? (
                <>
                  {/* 画像＋オーバーレイをまとめて拡大／パン（表示専用ズーム・260708）。imgLayout は wrapper 実寸基準なので変形非依存。 */}
                  <div
                    className="absolute inset-0"
                    style={{
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transformOrigin: '0 0',
                    }}
                  >
                  <img
                    ref={imgRef}
                    src={baseDisplayUrl}
                    alt="ベース"
                    draggable={false}
                    className={`absolute inset-0 w-full h-full object-contain select-none ${
                      activeObjectId && zoom === 1 ? 'cursor-crosshair' : ''
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
                  {overlayObjects.map((o, objIdx) => {
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
                  {activeTool === 'area' && dragStart && dragCurrent && (
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
                    {overlayObjects.map((o, objIdx) => {
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
                    {activeTool === 'area' &&
                      maskMode === 'polygon' &&
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
                  </div>
                  {/* ズーム操作（260708）: ホイールで拡大縮小、拡大中はドラッグで移動、リセットで等倍に戻す。表示専用（拡大中は作図不可）。 */}
                  {zoom > 1 ? (
                    <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5 rounded-md border border-white/15 bg-black/70 px-2 py-1 text-[10px] font-bold text-neutral-200 backdrop-blur-sm">
                      <span>{Math.round(zoom * 100)}%</span>
                      <span className="text-neutral-500">ドラッグで移動</span>
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={resetZoom}
                        className="rounded px-1.5 py-0.5 text-emerald-300 hover:bg-white/10"
                      >
                        リセット
                      </button>
                    </div>
                  ) : (
                    <div className="absolute bottom-2 right-2 z-10 rounded-md border border-white/10 bg-black/50 px-2 py-1 text-[10px] font-medium text-neutral-400 backdrop-blur-sm pointer-events-none">
                      マウスホイールで拡大・縮小
                    </div>
                  )}
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
                  multiple
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
                      '生成したい空間のイメージや条件を入力してください。\n【※入力内容に基づき、パース画像の生成が実行されます】\n\n例1）木の温もりを感じる、ナチュラルモダンなリビング\n例2）添付したブランドロゴの雰囲気に合う、高級感のあるカフェの内装\n例3）コンクリートとアイアン素材を組み合わせた、インダストリアルなオフィス'
                    }
                    rows={6}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-white leading-relaxed resize-none outline-none focus:border-emerald-500"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => styleInputRef.current?.click()}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-[11px] font-bold text-neutral-200 transition hover:bg-white/10 hover:text-white"
                    >
                      <Paperclip className="h-4 w-4" />
                      ファイルを添付
                    </button>
                    {draftStyleRefs.length > 0 && (
                      <span className="text-[10px] text-neutral-400">添付 {draftStyleRefs.length} / {MAX_STYLE_REFS} 枚</span>
                    )}
                  </div>
                  {/* 添付画像のサムネイル一覧（複数対応・各画像を個別に削除できる・260707）。
                      削除 index を合わせるため、フィルタ後(styleImageDataUrls)ではなく draftStyleRefs をそのまま描画する。 */}
                  {draftStyleRefs.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {draftStyleRefs.map((url, i) => (
                        <div key={`${i}-${url.slice(0, 24)}`} className="relative shrink-0">
                          <img src={url} alt={`添付${i + 1}`} className="h-12 w-12 rounded border border-white/10 object-cover" />
                          <button
                            type="button"
                            onClick={() => onRemoveStyleRefAt(i)}
                            className="absolute -right-1.5 -top-1.5 rounded-full bg-black/80 p-0.5 text-red-300 hover:bg-red-500/30"
                            aria-label={`添付${i + 1}を削除`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {activeTool === 'area' && (
            <div>
              {/* マスク方式の切替（260630・クライアントUI準拠でパネル上部へ移動）。多角形＝クリックで頂点、矩形＝ドラッグ。 */}
              <div className="mb-2 flex items-center gap-1.5">
                <div className="glass flex rounded-lg border border-white/10 p-0.5">
                  <button
                    type="button"
                    onClick={() => setMaskMode('polygon')}
                    className={`rounded-md px-3 py-1 text-[10px] font-black tracking-wider transition-colors ${
                      maskMode === 'polygon' ? 'bg-white text-black' : 'text-white/55 hover:text-white'
                    }`}
                  >
                    多角形
                  </button>
                  <button
                    type="button"
                    onClick={() => setMaskMode('rect')}
                    className={`rounded-md px-3 py-1 text-[10px] font-black tracking-wider transition-colors ${
                      maskMode === 'rect' ? 'bg-white text-black' : 'text-white/55 hover:text-white'
                    }`}
                  >
                    矩形
                  </button>
                </div>
                {/* 囲った範囲（マスク）の表示トグル（260708 クライアント要望「任意で表示・非表示」）。
                    エリア編集タブでのみ表示。作図中の範囲・選択中の履歴（版）の範囲の表示可否を切り替える。 */}
                <button
                  type="button"
                  onClick={() => setShowRangeOverlay((v) => !v)}
                  title="囲った範囲（マスク）の表示／非表示を切り替える"
                  aria-pressed={showRangeOverlay}
                  className={`ml-auto rounded-lg border px-2.5 py-1 text-[10px] font-black tracking-wider transition-colors ${
                    showRangeOverlay
                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      : 'border-white/10 text-white/45 hover:text-white'
                  }`}
                >
                  {showRangeOverlay ? '範囲: 表示' : '範囲: 非表示'}
                </button>
              </div>
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
                      {/* 縦積みレイアウト（260630・クライアントUI準拠）: ヘッダ→画像→指示文→範囲リストをカード幅いっぱいに。 */}
                      <div className="cursor-pointer space-y-1.5">
                        {/* ヘッダ: 領域件数（左）＋削除（右）をカード幅いっぱいに */}
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
                        {/* 参照画像: サムネ＋選択ボタン */}
                        <div className="flex items-center gap-2">
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
                          <div className="flex flex-wrap gap-1">
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
                        </div>
                        {/* 指示プロンプト（カード幅いっぱい） */}
                        <textarea
                          value={o.memo}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => onUpdateObjectMemo(o.id, e.target.value)}
                          placeholder="このエリア内にどのような編集を加えたいですか？"
                          rows={2}
                          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] resize-none"
                        />
                        {/* 範囲リスト（カード幅いっぱい） */}
                        <ul className="space-y-1">
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
              {activeTool === 'area' && submitWarning && !submitError && (
                <p className="text-xs text-amber-400 break-words">{submitWarning}</p>
              )}
              {activeTool === 'area' && emptyCardCount > 0 && (
                <p className="text-xs text-amber-300 font-bold">未入力{emptyCardCount}件</p>
              )}
              {/* ②「継ぎ目をなじませる（全体を1枚に均一化）」opt-in（260706→260709）。①（決定論の境界なじませ）でも薄い
                  継ぎ目が残るとき用。ONにすると仕上げに全体を1回AIで生成し直す＝より徹底的に継ぎ目を消せるが、全体再生成の
                  ため他がわずかに変わる可能性がある（クライアント選択: ①中心・②は任意）。効くのは切り取り（隠れた対象）時のみ。 */}
              {activeTool === 'area' && ENABLE_HARMONIZE_FLATTEN && (
                <label className="flex items-start gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-emerald-500"
                    checked={harmonizeSeams}
                    onChange={(e) => setHarmonizeSeams(e.target.checked)}
                    disabled={isSubmitting}
                  />
                  <span className="text-[11px] leading-snug text-neutral-300">
                    <span className="font-bold text-neutral-100">継ぎ目をなじませる（仕上げに全体を1回作り直す）</span>
                    <span className="block text-neutral-500">境界線がまだ気になるときだけON。より徹底的に消せますが、全体を作り直すため他が少し変わることがあります（少し時間がかかります）。</span>
                  </span>
                </label>
              )}
              {/* 画質を高める（精細化・260710）: 旧「見本画像を2枚目として添付」方式（ゴースト原因）を廃止し、
                  生成後に現在の1枚だけをAIで精細化する後処理に刷新。2枚目を渡さないのでゴースト/二重は起きない。 */}
              {activeTool === 'area' && ENABLE_KEEP_QUALITY_ENHANCE && (
                <label className="flex items-start gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-emerald-500"
                    checked={keepQuality}
                    onChange={(e) => setKeepQuality(e.target.checked)}
                    disabled={isSubmitting}
                  />
                  <span className="text-[11px] leading-snug text-neutral-300">
                    <span className="font-bold text-neutral-100">画質を高める（仕上げに精細化）</span>
                    <span className="block text-neutral-500">生成後に、構図・家具・配置・色を一切変えずに、ぼやけ・のっぺりを抑えて素材の精細感だけを引き上げます。編集を繰り返して画質が落ちてきたときにON（もう一度AIを通すため少し時間がかかります）。</span>
                  </span>
                </label>
              )}
              {/* 複数候補から選ぶ（Option 1・260717）: 生成枚数を選び、実行後に最良の1枚を選ぶ。既定 1。 */}
              {activeTool === 'area' && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2">
                  <span className="text-[11px] font-bold text-neutral-100">候補数</span>
                  <div className="flex gap-1">
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => setCandidateCount(n)}
                        className={`h-7 w-8 rounded-md border text-[12px] font-bold transition-colors ${
                          candidateCount === n
                            ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200'
                            : 'border-white/10 bg-black/30 text-neutral-300 hover:border-white/30'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] leading-tight text-neutral-500">
                    2枚以上にすると複数生成し、いちばん良い1枚を選べます（枚数分だけ生成に時間・回数がかかります）。
                  </span>
                </div>
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
                  candidatePick != null ||
                  !!projectSession?.aiCredits.blocked ||
                  (activeTool === 'area' && !canRunAreaEdit)
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

      {/* 複数候補ピッカー（Option 1・260717）: 生成した候補から最良の1枚を選ぶ。選ぶまで版は作らない／キャンセルで破棄。 */}
      {candidatePick && (
        <div
          className="fixed inset-0 z-[9500] flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-2xl border border-white/10 bg-[#0c0c0c] p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-neutral-100">
                  良い候補を1つ選んでください（{candidatePick.candidates.length}案）
                </h3>
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  コスト削減のため候補は下書き画質で提示しています。選んだ1枚だけを高画質に仕上げます（構図・家具の形はそのまま保たれます）。
                </p>
              </div>
              <button
                type="button"
                disabled={finalizingCandidate}
                onClick={() => setCandidatePick(null)}
                className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-neutral-300 transition hover:bg-white/5 disabled:opacity-40"
              >
                キャンセル（採用しない）
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              <div className="overflow-hidden rounded-lg border border-white/10">
                <img src={candidatePick.baseImageDataUrl} alt="編集前" className="block h-auto w-full" />
                <div className="bg-black/40 px-2 py-1.5 text-[11px] text-neutral-400">編集前（元画像）</div>
              </div>
              {candidatePick.candidates.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={finalizingCandidate}
                  onClick={() => void handleSelectCandidate(c)}
                  className="group overflow-hidden rounded-lg border-2 border-white/10 text-left transition-colors hover:border-emerald-500 disabled:opacity-50 disabled:pointer-events-none"
                >
                  <img src={c.url} alt={`候補${i + 1}`} className="block h-auto w-full" />
                  <div className="flex items-center justify-between bg-black/40 px-2 py-1.5 text-[11px] font-bold text-neutral-200 group-hover:bg-emerald-600/30">
                    <span>候補 {i + 1}</span>
                    <span className="text-emerald-300 opacity-0 group-hover:opacity-100">この案を高画質で採用 →</span>
                  </div>
                </button>
              ))}
            </div>
            {finalizingCandidate && (
              <div className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-black/40 py-2 text-sm text-neutral-200">
                <Loader2 className="h-4 w-4 animate-spin text-purple-400" />
                選んだ案を高画質に仕上げています…
              </div>
            )}
          </div>
        </div>
      )}

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
          <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-8 text-center shadow-2xl">
            <Loader2 className="h-14 w-14 animate-spin text-purple-400" />
            <div>
              <h3 className="mb-2 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-xl font-bold text-transparent">
                AIが画像を生成中…
              </h3>
              {/* 進捗（point3・260720）: 候補は逐次生成のため「N/total 完了」を実測表示。正確な％は生成APIが
                  途中経過を返さないため出さない（＝作り物にしない・誠実）。経過秒は実測。 */}
              {genProgress && genProgress.total > 1 ? (
                <p className="text-sm font-bold text-emerald-300">
                  {genProgress.done.length} / {genProgress.total} 枚 完了
                </p>
              ) : (
                <p className="text-sm text-zinc-400">しばらくお待ちください。</p>
              )}
              <p className="mt-1 text-xs text-zinc-500">経過 {genElapsedSec} 秒（通常 30〜90 秒ほど）</p>
            </div>
            {/* 進捗バーは「完了枚数/total」で確定分だけ塗る（実測ベース）。1枚だけのときは途中経過が取れないので出さない。 */}
            {genProgress && genProgress.total > 1 && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-400 to-purple-500 transition-all duration-500"
                  style={{ width: `${Math.round((genProgress.done.length / genProgress.total) * 100)}%` }}
                />
              </div>
            )}
            {/* 完了した候補を届いた順にサムネ表示＝進んでいることが見える（フリーズ不安の解消・最大の効果）。 */}
            {genProgress && genProgress.total > 1 && (
              <div className="flex w-full items-center justify-center gap-2">
                {Array.from({ length: genProgress.total }).map((_, i) => {
                  const url = genProgress.done[i];
                  return url ? (
                    <img
                      key={i}
                      src={url}
                      alt={`候補${i + 1}`}
                      className="h-16 w-16 rounded-md border border-emerald-500/50 object-cover"
                    />
                  ) : (
                    <div
                      key={i}
                      className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-zinc-700 bg-zinc-800/40"
                    >
                      <Loader2 className="h-4 w-4 animate-spin text-zinc-600" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* 生成待ち時間の右カラム: 上半分=広告／下半分=お役立ち情報（260707 クライアント要望の2分割）。 */}
          <RenderInfoColumn className="absolute right-6 top-1/2 -translate-y-1/2" />
        </div>
      )}
    </div>
  );
}
