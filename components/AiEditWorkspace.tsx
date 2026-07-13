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
import { pickClosestAspectRatio } from '../utils/pickClosestAspectRatio.js';
import { fitDataUrlToSize, coverCropLossFraction } from '../utils/fitDataUrl.js';
import { compositeMaskedEdit } from '../utils/compositeMaskedEdit.js';
import { placeCutoutIntoRegion } from '../utils/compositeCutout.js';
import { harmonizeEditToBase } from '../utils/tonalMatch.js';
import { shouldCompositeAreaEdit, GLOBAL_REGION_COVERAGE } from '../utils/areaEditDecision.js';
import { chooseAreaEditRoute } from '../lib/inpaint/inpaintRoute.js';
import { rasterizeMaskDataUrl } from '../utils/maskRaster.js';
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
import { ENABLE_HARMONIZE_FLATTEN, ENABLE_KEEP_QUALITY_ENHANCE } from '../lib/aiEditPrompt.js';
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

/**
 * マスクベース専用エンジン（削除/生成）でエリア編集を処理するかのフラグ（260711・フェーズ1）。
 * 既定 OFF。運営が Replicate 等の共通キー（サーバー env REPLICATE_API_TOKEN）を設定し、実機テスト準備が
 * できたら VITE_ENABLE_INPAINT=true で有効化する。有効でもエンジン失敗時は自動で従来 Gemini 経路へフォールバック。
 */
const ENABLE_INPAINT_ENGINE = import.meta.env.VITE_ENABLE_INPAINT === 'true';

/**
 * 参照商品の「決定論合成」経路（260712・フェーズ2）。既定 OFF。参照画像（差し替え/配置する家具の画像）が
 * あるエリア編集で、商品の切り抜きを囲った範囲へそのまま貼る（＝ブランド・比率・形が完全一致・AI幻覚なし）。
 * 切り抜きに Replicate（背景除去）を使うため、運営が REPLICATE_API_TOKEN を設定し実機準備ができたら
 * VITE_ENABLE_COMPOSITE=true で有効化する。有効でも失敗時は自動で従来 Gemini 経路へフォールバックする。
 */
const ENABLE_COMPOSITE = import.meta.env.VITE_ENABLE_COMPOSITE === 'true';

/**
 * 合成後の「AIリライト」（照明を背景へ馴染ませる・IC-Light 系）。既定 OFF・未検証のダークシップ。
 * 合成そのものは決定論で完結するため、リライトは任意の後処理。VITE_ENABLE_RELIGHT=true かつ実キーがあるときのみ
 * 実機で出力を確認してから使う。失敗しても合成結果はそのまま採用する（Gemini へは流さない）。
 */
const ENABLE_RELIGHT = import.meta.env.VITE_ENABLE_RELIGHT === 'true';

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

  const runEdit = useCallback(async () => {
    if (!activeVersion) return;
    setSubmitError(null);
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

      // エリア編集は「マスク領域だけ」を編集する独立機能（260702 クライアント指摘対応）。コーディネート欄の
      // スタイル/プロンプト（styleImage/styleMemo）は一切読み込まない。マスク領域＋余白をクロップして拡大送信し
      // （重なった家具の分離＝精度向上）、編集後は必ずベースへ貼り戻して多角形/矩形でクリップする。これにより
      // マスク外は常にベースのまま＝指定外は改変されない（＝拘束力の担保）。
      const allPlacements = draftObjects.flatMap((o) => o.placements);
      const unionBBox = allPlacements.length > 0 ? unionBBoxOfPlacements(allPlacements) : null;
      // 囲みの被覆率（幾何）で経路を決める（260711・参照画像の有無ではなく“範囲外を守るべきか”で判定）。
      // 実質全画面（被覆≥GLOBAL）＝守る外がほぼ無い→全画面直（継ぎ目なし）。それ未満は範囲外を必ず守る。
      const unionCoverage = unionBBox ? unionBBox.w * unionBBox.h : 1;
      const isGlobalRegion = allPlacements.length > 0 && unionCoverage >= GLOBAL_REGION_COVERAGE;

      // 生成結果。まず専用エンジン（削除/生成）を試し、失敗/無効なら下の Gemini 経路へフォールバックする（260711 フェーズ1）。
      let outUrl: string | null = null;

      // === マスクベース専用エンジン（削除/生成・260711 フェーズ1）===
      // エリア編集は「囲った範囲だけを変える」。削除/生成はマスク方式の専用エンジンで処理し、範囲外は
      // 必ずベースへ貼り戻して1ピクセルも変えない。エンジンが未設定/失敗なら outUrl は null のままで Gemini へフォールバック。
      const instructionText = draftObjects
        .flatMap((o) => [o.memo, ...(o.placementMemos ?? [])])
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
        .join(' / ');
      const hasReferenceImage = objectsScaled.some((o) => !!o.imageDataUrl);
      const route = chooseAreaEditRoute({ instruction: instructionText, hasReferenceImage, unionCoverage });
      // 削除(inpaint-remove)は専用エンジンを使わず Gemini クロップ＋閉じ込めへ回す（260714 方針転換）。
      // 実機比較で LaMa/Bria の埋め戻しより Gemini の holistic 再生成の方が自然（継ぎ目/青み/ゴーストが出ない）で、
      // クロップ経路なら範囲外はモデルに渡らず不変。よってこのブロックはテキストのみのマスク内生成(generate)だけを扱う。
      if (ENABLE_INPAINT_ENGINE && allPlacements.length > 0 && route === 'inpaint-generate') {
        try {
          // マスクは範囲＋わずかな膨張（生成物が縁で切れないよう）。範囲外の保証は下の貼り戻しで別途担保する。
          const maskDilate = Math.round(Math.max(baseW, baseH) * 0.01);
          const maskDataUrl = await rasterizeMaskDataUrl(allPlacements, baseW, baseH, { dilatePx: maskDilate });
          const referenceImageDataUrl = objectsScaled.find((o) => !!o.imageDataUrl)?.imageDataUrl ?? null;
          const ires = await fetch('/api/ai-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
            body: JSON.stringify({
              inpaint: true,
              op: 'generate',
              imageDataUrl: baseScaled,
              maskDataUrl,
              prompt: instructionText,
              referenceImageDataUrl,
            }),
          });
          const idata = await ires.json();
          if (idata.success && idata.url) {
            // 範囲外を絶対に変えない保証: エンジン出力をベース寸法へ整え、範囲外はベースへ貼り戻す（マスク外はバイト保持）。
            const fitted = await fitDataUrlToSize(idata.url as string, baseW, baseH, 'cover');
            const feather = Math.round(Math.max(baseW, baseH) * 0.008);
            // 生成は範囲内に新規生成＝周囲へなじませたいのでトーン合わせを維持する。
            const matched = await harmonizeEditToBase(baseScaled, fitted, allPlacements, baseW, baseH);
            outUrl = await compositeMaskedEdit(baseScaled, matched, allPlacements, baseW, baseH, feather);
            void recordAiUsage({
              feature: 'ai_edit',
              model: (idata.engine as string) || 'inpaint',
              imageCount: 1,
              projectId: projectSession?.projectId ?? null,
            });
          }
          // idata.success=false（キー未設定・失敗など）→ outUrl は null のまま → 下の Gemini 経路へフォールバック。
        } catch {
          /* ネットワーク等の失敗 → Gemini へフォールバック */
        }
      }

      // 置き換えの第1段（260714 クライアント要望）: Gemini で「囲った範囲の中身を消して背景だけ」にしたクリーンな
      // ベースを作る（crop+confine で範囲外は不変）。これを土台に第2段で参照商品を配置＝“追加”でなく“置き換え”。
      // トーン合わせは削除では行わない（対象色に引っ張られてゴースト化するため）。失敗時は null（呼び出し側は元
      // ベースへ配置＝従来の追加挙動へフェイルソフト）。
      const geminiEmptyRegion = async (base: string): Promise<string | null> => {
        try {
          const useCropR = !!unionBBox && isConfinedRegion(unionBBox);
          let cropR: CropPx | null = null;
          if (useCropR && unionBBox) {
            const bbox = padBBox(unionBBox);
            const targetAspect = parseAspectRatioKey(
              pickClosestAspectRatio(Math.max(1, Math.round(bbox.w * baseW)), Math.max(1, Math.round(bbox.h * baseH)))
            );
            const candidate = snapCropToAspect(bbox, baseW, baseH, targetAspect);
            if (shouldCropRegion(bbox, candidate, baseW, baseH)) cropR = candidate;
          }
          const removeObjects = [
            {
              id: 'replace-clear',
              imageDataUrl: null,
              memo: 'この範囲の中にある物・家具をすべて消し、壁と床だけの何も無い状態にしてください。',
              placements: cropR ? remapPlacementsToCrop(allPlacements, cropR, baseW, baseH) : allPlacements,
            },
          ];
          const postBase = cropR ? await cropDataUrl(base, cropR) : base;
          const postAspect = cropR ? pickClosestAspectRatio(cropR.sw, cropR.sh) : aspectRatio;
          const res = await fetch('/api/ai-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
            body: JSON.stringify({ baseImage: postBase, objects: removeObjects, aspectRatio: postAspect, imageSize, strictConfine: true }),
          });
          const data = await res.json();
          if (!data.success || !data.url) return null;
          void recordAiUsage({ feature: 'ai_edit', usage: data.usage, model: data.model, imageCount: 1, projectId: projectSession?.projectId ?? null });
          const feather = Math.round(Math.max(baseW, baseH) * 0.008);
          if (cropR) {
            const cropRect: NormalizedRect = { x: cropR.sx / baseW, y: cropR.sy / baseH, width: cropR.sw / baseW, height: cropR.sh / baseH };
            const fittedCrop = await fitDataUrlToSize(data.url as string, cropR.sw, cropR.sh, 'cover');
            const full = await pasteCropIntoBase(base, fittedCrop, cropR, baseW, baseH);
            return await compositeMaskedEdit(base, full, [cropRect], baseW, baseH, feather);
          }
          const fitted = await fitDataUrlToSize(data.url as string, baseW, baseH, 'cover');
          return await compositeMaskedEdit(base, fitted, allPlacements, baseW, baseH, feather);
        } catch {
          return null;
        }
      };

      // === 決定論合成（参照商品の忠実配置・260712 フェーズ2 / 置き換え2段化・260714）===
      // 参照画像（差し替え/配置する家具）があるエリア編集は、AIに生成させず「商品の切り抜きをそのまま貼る」。
      // 商品ピクセルはモデルに一切渡さないので、ブランド・比率・形が完全一致し、幻覚も起きない。
      // 第1段: 範囲内の既存物を Gemini で除去（geminiEmptyRegion）。第2段: 除去済みベースへ切り抜きを配置。
      // 切り抜き（背景除去）だけ Replicate を使い、配置・閉じ込めはクライアントで決定論的に行う（照明合わせは任意）。
      if (ENABLE_COMPOSITE && outUrl == null && allPlacements.length > 0 && route === 'composite') {
        try {
          const refObjects = objectsScaled.filter((o) => !!o.imageDataUrl);
          if (refObjects.length === 0) throw new Error('参照画像なし'); // 念のため（route=composite は参照ありのはず）
          // 第1段: 既存物を除去して背景だけのベースを作る（失敗時は元ベース＝従来の“追加”へフェイルソフト）。
          const cleaned = await geminiEmptyRegion(baseScaled);
          const placeBase = cleaned ?? baseScaled;
          // 第2段: 参照商品の切り抜きを除去済みベースへ配置する。
          let placed = placeBase;
          for (const o of refObjects) {
            // 各参照はその領域（複数なら結合矩形）へ配置する。領域が無ければ全体の結合矩形にフォールバック。
            const region = (o.placements.length > 0 ? unionBBoxOfPlacements(o.placements) : unionBBox) ?? unionBBox;
            if (!region) continue;
            // 切り抜き（背景除去）。失敗すれば throw → 下の catch で Gemini へフェイルソフト。
            const cres = await fetch('/api/ai-edit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
              body: JSON.stringify({ inpaint: true, op: 'cutout', imageDataUrl: o.imageDataUrl }),
            });
            const cdata = await cres.json();
            if (!cdata.success || !cdata.url) throw new Error('cutout 失敗');
            // 決定論配置（アスペクト維持・床接地）。被写体なし/退化/失敗は null → throw で Gemini へフェイルソフト。
            const next = await placeCutoutIntoRegion(placed, cdata.url as string, region, { fitFrac: 0.9, anchor: 'floor' });
            if (next == null) throw new Error('切り抜きに被写体がありません（フェイルソフト）');
            placed = next;
            void recordAiUsage({
              feature: 'ai_edit',
              model: (cdata.engine as string) || 'cutout',
              imageCount: 1,
              projectId: projectSession?.projectId ?? null,
            });
          }
          // 第3段: 描いた範囲でクリップして貼り戻す。**外側は元画像(baseScaled)から復元**する（除去済みベース
          //   placeBase ではない）。placeBase は crop+pad を Gemini が再生成しているため、描いた範囲の外側の帯
          //   （crop と範囲の差分）に別の家具の消失等が焼き込まれうる。外側を baseScaled にすることで、範囲外は
          //   元画像とバイト一致＝「範囲内の椅子を消したのに範囲外の椅子が消えた」型の破れを防ぐ（260714 検証で検出）。
          //   範囲内(placed)は placeBase 由来＝既存物が消えた床＋商品なので、置き換えは成立する。
          const feather = Math.round(Math.max(baseW, baseH) * 0.008);
          outUrl = await compositeMaskedEdit(baseScaled, placed, allPlacements, baseW, baseH, feather);

          // 第4段（任意・既定OFF）AIリライト: 照明を背景へ馴染ませる。失敗しても合成結果を維持（Gemini へは流さない）。
          if (ENABLE_RELIGHT && outUrl) {
            try {
              const rres = await fetch('/api/ai-edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
                body: JSON.stringify({
                  inpaint: true,
                  op: 'relight',
                  imageDataUrl: outUrl,
                  backgroundImageDataUrl: placeBase,
                  prompt: instructionText,
                }),
              });
              const rdata = await rres.json();
              if (rdata.success && rdata.url) {
                const relit = await fitDataUrlToSize(rdata.url as string, baseW, baseH, 'cover');
                // 第3段と同じく外側は元画像から復元（範囲外バイト保持）。
                outUrl = await compositeMaskedEdit(baseScaled, relit, allPlacements, baseW, baseH, feather);
              }
            } catch {
              /* リライト失敗 → 合成結果（outUrl）をそのまま採用 */
            }
          }
        } catch {
          // 切り抜き/合成の失敗 → outUrl は null のまま → 下の Gemini 経路へフェイルソフト。
          outUrl = null;
        }
      }

      // === Gemini 経路（専用エンジンが未使用/失敗のときのみ）===
      if (outUrl == null) {
      // 生成前の事前解析（対象の説明 narratives・260709）。クロップ経路の出し分けは被覆率（幾何・isConfinedRegion）で
      // 決めるようになった（260711）ので、この解析は「どの対象を編集するか」の特定補助に使う（遮蔽判定は今は使わない）。
      // narratives は生成本体へ渡して再解析を省く（二重解析回避）。解析失敗は narratives 無しで続行。
      let narratives: Record<string, string> = {};
      try {
        // 事前解析は /api/ai-edit に analyze:true で相乗り（Hobbyプランのサーバレス関数数上限=12 対策・専用
        // エンドポイントを増やさない・260709）。遮蔽判定はベース画像＋範囲（座標）だけで足りるので、参照画像
        // (imageDataUrl)は外して送る（Vercel body 上限に対する payload 削減）。
        const ares = await fetch('/api/ai-edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
          body: JSON.stringify({
            analyze: true,
            baseImage: baseScaled,
            objects: objectsScaled.map((o) => ({ ...o, imageDataUrl: null })),
          }),
        });
        const adata = await ares.json();
        if (adata?.success) {
          narratives = adata.narratives ?? {};
        }
      } catch {
        /* 解析失敗は非クロップ（自然）で続行 */
      }

      // クロップ（案1）は「囲みが局所（isConfinedRegion）」なら常時使う（260711・以前は遮蔽時だけ）。
      // 囲みの範囲だけをモデルへ送る＝範囲外の画素はモデルに渡らない＝範囲外は物理的に絶対変わらない
      // （クライアント「範囲内の椅子を消したのに範囲外の椅子が消えた」＝閉じ込め破れの恒久対策）。
      // クロップ内の対象は一意なので取り違えも起きにくい。遮蔽解析(narratives)は対象特定に引き続き利用。
      const useCrop = !!unionBBox && isConfinedRegion(unionBBox);

      let cropPx: CropPx | null = null;
      if (useCrop && unionBBox) {
        const bbox = padBBox(unionBBox);
        const targetAspect = parseAspectRatioKey(
          pickClosestAspectRatio(Math.max(1, Math.round(bbox.w * baseW)), Math.max(1, Math.round(bbox.h * baseH)))
        );
        const candidate = snapCropToAspect(bbox, baseW, baseH, targetAspect);
        if (shouldCropRegion(bbox, candidate, baseW, baseH)) cropPx = candidate;
      }

      // クロップ経路ではベース画像・配置座標・アスペクト比をクロップ空間に統一して送る（サーバの位置説明生成も同座標系で整合）。
      const postBase = cropPx ? await cropDataUrl(baseScaled, cropPx) : baseScaled;
      const postObjects = cropPx
        ? objectsScaled.map((o) => ({ ...o, placements: remapPlacementsToCrop(o.placements, cropPx as CropPx, baseW, baseH) }))
        : objectsScaled;
      const postAspect = cropPx ? pickClosestAspectRatio(cropPx.sw, cropPx.sh) : aspectRatio;

      // エリア編集はスタイル参照/コーディネートのプロンプトを送らない（機能の独立性・コーディネートとは混線させない）。
      const body: Record<string, unknown> = {
        baseImage: postBase,
        objects: postObjects,
        aspectRatio: postAspect,
        imageSize,
        learnedHints,
        // 切り取り（案1）のときは範囲に厳密＝strict、通常（自然）は soft でプロンプトの言い回しを一致させる。
        strictConfine: !!cropPx || (allPlacements.length > 0 && !isGlobalRegion),
        // 事前解析は解析済みを渡して再解析を省く（二重解析回避）。クロップ時は座標系が変わるが説明は対象識別用（参考）なので流用可。
        ...(Object.keys(narratives).length > 0 ? { placementNarratives: narratives } : {}),
      };

      const res = await fetch('/api/ai-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '編集に失敗しました');
      // トークン計測（row 58・無効時は no-op）。
      void recordAiUsage({ feature: 'ai_edit', usage: data.usage, model: data.model, imageCount: 1, projectId: projectSession?.projectId ?? null });

      outUrl = data.url as string;
      // 編集結果の後処理。
      // ・案1（cropPx あり＝囲みが局所 isConfinedRegion のとき・260711）: 切り取り編集をベースへ貼り戻し→境界を
      //   決定論でなじませ（①）→クロップ矩形でクリップ合成。範囲外はモデルへ送っていない＝バイト保持で一切変えない。
      // ・全画面（大領域/実質全画面）: 被覆 < 0.85 は合成して範囲外をベース復元、≥ 0.85 は全画面のまま採用。
      if (cropPx) {
        // 合成マスクは「囲った多角形」ではなく「クロップ矩形（対象＋余白）」を使う（260709 クライアント報告
        // 「差し替えた椅子が全部表示されない＝見切れる」対策）。多角形で切り抜くと、差し替え家具が元の小さな囲み
        // （＝隠れた対象の“見えている一部”に密着）で切れてしまう。クロップは対象＋余白を含み、モデルはクロップ内で
        // 手前のソファによる遮蔽も正しく描くので、クロップ矩形ごと貼り戻せば新しい家具が（正しく遮蔽されたうえで）
        // 全体表示される。矩形の縁は羽根ぼかし＋色合わせ（①）でなじませ、矩形の外は完全にベースのまま。
        // 代償: クロップ矩形内の周辺（手前ソファの縁・壁・床の一部）も再生成されるが、クロップは対象に密着した
        // 小さめ範囲なので変化は局所的。
        const cropRect: NormalizedRect = {
          x: cropPx.sx / baseW,
          y: cropPx.sy / baseH,
          width: cropPx.sw / baseW,
          height: cropPx.sh / baseH,
        };
        const cropFeather = Math.round(Math.max(baseW, baseH) * 0.008); // 矩形の縁をやや広めにぼかしてなじませる
        const fittedCrop = await fitDataUrlToSize(outUrl, cropPx.sw, cropPx.sh, 'cover');
        const full = await pasteCropIntoBase(baseScaled, fittedCrop, cropPx, baseW, baseH);
        const matched = await harmonizeEditToBase(baseScaled, full, [cropRect], baseW, baseH);
        outUrl = await compositeMaskedEdit(baseScaled, matched, [cropRect], baseW, baseH, cropFeather);
      } else {
        // 全画面生成をベース寸法へ整える。アスペクト差が大きいときだけ contain（差し替え家具が欠けないように）。
        const { w: gemW, h: gemH } = await loadImageNaturalSize(outUrl);
        // 囲まれた範囲（局所・非全画面）は「範囲外を絶対に変えない」を最優先（クライアント必須指摘260711）。
        // contain（レターボックス）は座標がズレるため合成をスキップ＝全画面をそのまま採用＝範囲外が変わりうる。
        // よって bounded（placementあり＆非グローバル）のときは常に cover に固定し、必ず合成→範囲外をベース復元する。
        // 代償: モデルがアスペクトを大きく外した稀ケースで差し替え家具の縁が欠けうるが、閉じ込め＞完全表示（①）。
        const isBoundedRegion = allPlacements.length > 0 && !isGlobalRegion;
        const mode: 'cover' | 'contain' =
          !isBoundedRegion && coverCropLossFraction(gemW / gemH, baseW / baseH) > 0.1 ? 'contain' : 'cover';
        const fitted = await fitDataUrlToSize(outUrl, baseW, baseH, mode);
        // 合成する/しないの判定は shouldCompositeAreaEdit（被覆率基準・260711）に集約。
        // ・囲まれた範囲（被覆 < 0.85）→ 参照画像の有無を問わず必ず合成（マスク外をベースへ厳密復元）＝範囲外を
        //   絶対に変えない（クライアント致命報告260711「範囲内の椅子を消したら範囲外の椅子が消えた」対応）。
        //   ※ さらに小さい範囲（被覆 < 0.6）はそもそも上流で crop 経路に回り、範囲外をモデルへ送らない。
        // ・実質全画面（被覆 ≥ 0.85）→ 守る外がほぼ無いので全画面のまま採用＝継ぎ目なし（260707 挙動を温存）。
        //   膨張(dilate)は差し替え家具が囲みの縁で切れるのを防ぐ生成ズレ吸収（隙間を橋渡ししない小ささ）。
        if (shouldCompositeAreaEdit({ placementCount: allPlacements.length, fitMode: mode, unionCoverage })) {
          const dilate = Math.round(Math.max(baseW, baseH) * 0.01); // ≈10px@1024（隙間を橋渡ししない小ささ＋生成ズレ吸収）
          const feather = Math.round(Math.max(baseW, baseH) * 0.008);
          const matched = await harmonizeEditToBase(baseScaled, fitted, allPlacements, baseW, baseH);
          outUrl = await compositeMaskedEdit(baseScaled, matched, allPlacements, baseW, baseH, feather, dilate);
        } else {
          outUrl = fitted;
        }
      }
      // ②（任意・opt-in・既定OFF）: 「継ぎ目をなじませる（全体を1枚に均一化）」AI再生成パス（260706 クライアント提案）。
      // ①（決定論の境界なじませ）でも薄い継ぎ目が残るとき用。切り取り経路（cropPx）のときだけ効かせる（自然経路は
      // 継ぎ目が無く不要）。全体再生成のため『他を一切変えない』保証はこのパスを ON にした時だけ外れる（クライアント了承済み）。
      // 失敗時は合成結果をそのまま使う。
      if (ENABLE_HARMONIZE_FLATTEN && harmonizeSeams && cropPx) {
        try {
          const hres = await fetch('/api/ai-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
            body: JSON.stringify({
              baseImage: outUrl,
              harmonize: true,
              aspectRatio: pickClosestAspectRatio(baseW, baseH),
              imageSize,
            }),
          });
          const hdata = await hres.json();
          if (hdata.success && hdata.url) {
            void recordAiUsage({ feature: 'ai_edit', usage: hdata.usage, model: hdata.model, imageCount: 1, projectId: projectSession?.projectId ?? null });
            outUrl = await fitDataUrlToSize(hdata.url as string, baseW, baseH, 'cover');
          }
        } catch {
          /* 均一化失敗は無視＝合成結果をそのまま使う */
        }
      }
      } // === Gemini 経路ここまで（if (outUrl == null)）===

      // 専用エンジンも Gemini も結果を得られなかった場合の保険（通常は上でどちらかが outUrl を設定する）。
      if (outUrl == null) {
        throw new Error('編集に失敗しました。しばらくして再度お試しください。');
      }
      // 「画質を高める（仕上げに精細化）」（260710）: keepQuality=ON のとき、確定した結果の“現在の1枚だけ”を
      // もう一度AIに通し、構図・家具・色を変えずに素材の質感と輪郭のキレだけを引き上げる。見本画像（2枚目）は
      // 一切渡さない＝重ね焼き（ゴースト）が構造的に起きない。失敗時は元の結果をそのまま使う（best-effort）。
      if (ENABLE_KEEP_QUALITY_ENHANCE && keepQuality) {
        try {
          const eres = await fetch('/api/ai-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
            body: JSON.stringify({
              baseImage: outUrl,
              enhanceDetail: true,
              aspectRatio: pickClosestAspectRatio(baseW, baseH),
              imageSize, // 1K 据え置き（2K はこのモデルで白っぽくぼやける既知事象）
            }),
          });
          const edata = await eres.json();
          if (edata.success && edata.url) {
            void recordAiUsage({ feature: 'ai_edit', usage: edata.usage, model: edata.model, imageCount: 1, projectId: projectSession?.projectId ?? null });
            outUrl = await fitDataUrlToSize(edata.url as string, baseW, baseH, 'cover');
          }
        } catch {
          /* 精細化失敗は無視＝元の結果をそのまま使う */
        }
      }
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
        // エリア編集はコーディネートのスタイルを保持しない（独立機能）。
        styleRefDataUrls: [],
        styleMemo: '',
        objects: draftObjects.map((o) => ({
          ...o,
          placements: o.placements.map((p) => ({ ...p })),
          placementMemos: [...(o.placementMemos ?? [])],
        })),
      });
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'エラー');
    } finally {
      setIsSubmitting(false);
    }
  }, [activeVersion, versions, draftObjects, onEditSuccess, isFreePlan, projectSession, harmonizeSeams, keepQuality]);

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
      const styleScaledList = await Promise.all(
        styleImageDataUrls.map(async (u) => downscaleDataUrlIfNeeded(await ensureDataUrl(u), 1280)),
      );
      // 添付画像が多い/大きいと Vercel の body 上限(~4.5MB)を超えて不明瞭なエラーになるため、送信前に合計サイズを
      // 概算チェックし、超過時は分かりやすいメッセージで止める（260707 検証 should-fix）。
      const approxBytes = (u: string) => Math.floor((u.length * 3) / 4);
      const totalBytes = approxBytes(baseScaled) + styleScaledList.reduce((s, u) => s + approxBytes(u), 0);
      if (totalBytes > 4_000_000) {
        setSubmitError('添付画像の合計サイズが大きすぎます。枚数を減らすか、小さめの画像でお試しください。');
        setIsSubmitting(false);
        return;
      }
      const hasPrompt = styleMemo.length > 0 || styleScaledList.length > 0;
      const body: Record<string, unknown> = hasPrompt
        ? {
            baseImage: baseScaled,
            styleImages: styleScaledList,
            objects: [],
            aspectRatio,
            imageSize: PREVIEW_GEMINI_IMAGE_SIZE,
            learnedHints,
            ...(styleMemo ? { styleMemo } : {}),
          }
        : { baseImage: baseScaled, coordinate: true, aspectRatio, imageSize: PREVIEW_GEMINI_IMAGE_SIZE, learnedHints };
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
          {/* 生成待ち時間の右カラム: 上半分=広告／下半分=お役立ち情報（260707 クライアント要望の2分割）。 */}
          <RenderInfoColumn className="absolute right-6 top-1/2 -translate-y-1/2" />
        </div>
      )}
    </div>
  );
}
