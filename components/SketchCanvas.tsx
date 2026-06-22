import React, { useState, useRef, useEffect, useCallback } from 'react';

import { NumericField } from './NumericField.js';
import { Point, Opening, OpeningType, ToolMode, AddKind, FurnitureItem } from '../types.js';
import type { UnderlaySettings, Beam } from '../lib/project/projectState.js';
import { useRenderOverlayStore } from '../lib/store/renderOverlayStore.js';
import { useProjectStore } from '../lib/store/projectStore.js';
import { useStore } from 'zustand';
import { Undo2, Redo2 } from 'lucide-react';
import { useConfirm } from './ConfirmDialog.js';
import {
  SKETCH_BASE_SCALE,
  getRoomTransform,
  getWallSegment,
  getWallBeamBandCornersMm,
  freeBeamWallMiterCornersMm,
  polygonCentroidMm,
  computeWallToWallSpan,
  lerpPoint,
  getWallAngle2D,
  furniturePositionToMm,
  mmToFurniturePosition,
  mmToScaled,
  sketchAngleToYaw,
  yawToSketchRotation,
  clampOpeningRatioWithCollisions,
  getEffectiveOpeningWidthMm,
  getFurnitureFootprintMm,
  isFurnitureFootprintInsidePolygon,
  slideFurnitureCenterMmWithWallContact
} from '../utils/sketchTransform.js';

const SKETCH_VIEW_DEFAULT_ZOOM = 0.08;

/** 極端ズームアウト時は辺寸法・家具名ラベルを描かず measureText 負荷を抑える */
const MIN_ZOOM_FOR_SKETCH_LABELS = 0.018;
const MIN_ZOOM_FOR_FURNITURE_LABELS = 0.03;
const MIN_LABEL_RECT_PX = 22;
const MAX_FURNITURE_LABEL_CHARS = 14;

/** これ未満は家具をマーカーのみ（極端ズームの負荷抑制） */
const MIN_ZOOM_FOR_FURNITURE_DOT_ONLY = 0.025;
/** これ未満は軽量足跡＋短矢印・小型選択十字のみ。これ以上で従来のフルギズモ＋回転リング */
const MIN_ZOOM_FOR_FURNITURE_FULL_GIZMO = SKETCH_VIEW_DEFAULT_ZOOM * 0.625;

/** 図面外接矩形の余白 mm（handleFitToScreen の padding と一致） */
const FLOORPLAN_ZOOM_PADDING_MM = 1000;
const PERF_TRACE = false;
const PERF_FRAME_WARN_MS = 20;
/**
 * 全体が収まるズーム（zoomFit）よりこれ以上ズームアウトしない下限の係数。
 * 1 に近いほど「全体表示」に近いところで止まる。
 */
/** 小さいほどズームアウト可能域が広がる（zoomFit に対する比率） */
const ZOOM_OUT_MIN_RELATIVE_TO_FIT = 0.2;
const GLOBAL_ZOOM_MIN = 0.0025;
const GLOBAL_ZOOM_MAX = 10;

/**
 * 作図点の外接矩形に基づき、これ以上ズームアウト（数値を下げる）しない下限を返す。
 * 点が2未満のときはグローバル下限のみ。
 */
function computeMinZoomForFloorplan(
  floorPointsMm: Point[],
  canvasW: number,
  canvasH: number
): number {
  if (floorPointsMm.length < 2) return GLOBAL_ZOOM_MIN;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of floorPointsMm) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const widthMm = maxX - minX + FLOORPLAN_ZOOM_PADDING_MM * 2;
  const heightMm = maxY - minY + FLOORPLAN_ZOOM_PADDING_MM * 2;
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
    return GLOBAL_ZOOM_MIN;
  }
  const zoomX = canvasW / widthMm;
  const zoomY = canvasH / heightMm;
  const zoomFit = Math.min(zoomX, zoomY, 2.0);
  if (!Number.isFinite(zoomFit) || zoomFit <= 0) return GLOBAL_ZOOM_MIN;
  const floorMin = zoomFit * ZOOM_OUT_MIN_RELATIVE_TO_FIT;
  return Math.min(GLOBAL_ZOOM_MAX, Math.max(GLOBAL_ZOOM_MIN, floorMin));
}

/** ズームに応じてギズモ矢印のスケール（参照は初期ズーム） */
function getArrowGizmoScale(currentZoom: number, defaultZoom: number = SKETCH_VIEW_DEFAULT_ZOOM) {
  const raw = Math.sqrt(defaultZoom / currentZoom);
  return Math.max(0.75, Math.min(1.35, raw));
}

/** 足跡外接円＋余白（px）。極端な大きさはクランプ */
function getFurnitureRotationRingRadiusPx(widthMm: number, depthMm: number, zoom: number) {
  const halfW = (widthMm * zoom) / 2;
  const halfD = (depthMm * zoom) / 2;
  const circum = Math.hypot(halfW, halfD);
  const pad = 8 * getArrowGizmoScale(zoom);
  const r = circum + pad;
  const minR = 22 * getArrowGizmoScale(zoom);
  const maxR = 130 * getArrowGizmoScale(zoom);
  return Math.max(minR, Math.min(maxR, r));
}

/** 非有限寸法・座標で Canvas API が固まるのを防ぐ */
function isSafeFurniture2DDraw(widthMm: number, depthMm: number, centerPx: Point): boolean {
  return (
    Number.isFinite(widthMm) &&
    Number.isFinite(depthMm) &&
    widthMm > 0 &&
    depthMm > 0 &&
    Number.isFinite(centerPx.x) &&
    Number.isFinite(centerPx.y)
  );
}

function truncateFurnitureLabel(text: string, maxChars = MAX_FURNITURE_LABEL_CHARS): string {
  const src = text.trim();
  if (!src) return '';
  if (src.length <= maxChars) return src;
  return `${src.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** 家具回転 UI：二重弧＋矢印。左側弧・矢印のみ Y 軸で反転。描画半径は ringR。 */
function drawFurnitureRotationRingIcon(
  ctx: CanvasRenderingContext2D,
  ringR: number,
  opts: { dashed?: boolean; lineWidth?: number; strokeStyle?: string; fillStyle?: string; gizmoScale?: number }
) {
  const { dashed = false, lineWidth = 2.4, strokeStyle = '#2563eb', fillStyle = '#2563eb', gizmoScale = 1 } = opts;
  ctx.strokeStyle = strokeStyle;
  ctx.fillStyle = fillStyle;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  const dashUnit = 4 * gizmoScale;
  ctx.setLineDash(dashed ? [dashUnit, dashUnit] : []);

  const tipLen = 7 * gizmoScale;
  const tipHalf = 4.2 * gizmoScale;

  const fillArrowAtArcEnd = (a: number, ccw: boolean) => {
    const px = Math.cos(a) * ringR;
    const py = Math.sin(a) * ringR;
    let tx = -Math.sin(a);
    let ty = Math.cos(a);
    if (!ccw) {
      tx = -tx;
      ty = -ty;
    }
    const bx = px - tx * tipLen;
    const by = py - ty * tipLen;
    const nx = -ty;
    const ny = tx;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(bx + nx * tipHalf, by + ny * tipHalf);
    ctx.lineTo(bx - nx * tipHalf, by - ny * tipHalf);
    ctx.closePath();
    ctx.fill();
  };

  ctx.beginPath();
  ctx.arc(0, 0, ringR, (7 * Math.PI) / 4, Math.PI / 4, false);
  ctx.stroke();

  ctx.save();
  ctx.scale(1, -1);
  ctx.beginPath();
  ctx.arc(0, 0, ringR, (3 * Math.PI) / 4, (5 * Math.PI) / 4, false);
  ctx.stroke();
  fillArrowAtArcEnd((3 * Math.PI) / 4, false);
  ctx.restore();

  fillArrowAtArcEnd(Math.PI / 4, true);

  ctx.setLineDash([]);
}

interface SketchCanvasProps {
  initialPoints?: Point[];
  onSketchUpdate: (points: Point[], isClosed: boolean) => void;
  onApply: (points: Point[]) => void;
  gridSize?: number; // mm (Grid visualization & absolute snap)
  lengthSnapSize?: number; // mm (Relative length snap)
  isLengthSnapEnabled?: boolean;
  angleSnap?: number; // degrees
  isAngleSnapEnabled?: boolean;
  onGridSizeChange: (size: number) => void;
  onLengthSnapSizeChange: (size: number) => void;
  onLengthSnapToggle: (enabled: boolean) => void;
  onAngleSnapChange: (angle: number) => void;
  onAngleSnapToggle: (enabled: boolean) => void;
  openings: Opening[];
  setOpenings: React.Dispatch<React.SetStateAction<Opening[]>>;
  selectedOpeningId: string | null;
  onOpeningSelect: (id: string | null) => void;
  toolMode: ToolMode;
  setToolMode: (mode: ToolMode) => void;
  addKind: AddKind;
  setAddKind: (kind: AddKind) => void;
  furnitureItems: FurnitureItem[];
  onFurnitureUpdate: React.Dispatch<React.SetStateAction<FurnitureItem[]>>;
  activeFurnitureId: string | null;
  onFurnitureSelect: (id: string | null, additive?: boolean) => void;
  /** 下絵（2D背景画像）。null で非挿入。 */
  underlay?: UnderlaySettings | null;
  onUnderlayChange?: (underlay: UnderlaySettings | null) => void;
  /** 梁（パラメトリックな2D要素）。 */
  beams?: Beam[];
  onBeamsChange?: (beams: Beam[]) => void;
  /** 平面図(false)/天伏図(true)の表示モード。App が単一の真実として保持。 */
  isCeilingView?: boolean;
  onCeilingViewChange?: (v: boolean) => void;
  /** 全消去: App 側で確定済みの壁/建具/家具/梁/選択もまとめてクリアする。 */
  onClearAll?: () => void;
}

const ToggleSwitch = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
  <button onClick={onChange} className={`w-11 h-6 rounded-full relative transition-all duration-300 flex items-center px-0.5 ${enabled ? 'bg-emerald-500' : 'bg-neutral-800 border border-white/10'}`}>
    <div className={`w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
  </button>
);

export const SketchCanvas: React.FC<SketchCanvasProps> = ({
  initialPoints,
  onSketchUpdate, 
  onApply, 
  gridSize = 1000, 
  lengthSnapSize = 1000,
  isLengthSnapEnabled = true,
  angleSnap = 45, 
  isAngleSnapEnabled = true,
  onGridSizeChange,
  onLengthSnapSizeChange,
  onLengthSnapToggle,
  onAngleSnapChange,
  onAngleSnapToggle,
  openings,
  setOpenings,
  selectedOpeningId,
  onOpeningSelect,
  toolMode,
  setToolMode,
  addKind,
  setAddKind,
  furnitureItems,
  onFurnitureUpdate,
  activeFurnitureId,
  onFurnitureSelect,
  underlay = null,
  onUnderlayChange,
  beams = [],
  onBeamsChange,
  isCeilingView = false,
  onCeilingViewChange,
  onClearAll
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasBoxRef = useRef<HTMLDivElement | null>(null);
  const pointerCaptureIdRef = useRef<number | null>(null);
  const requestRef = useRef<number | null>(null);
  const mousePosRef = useRef<Point>({ x: 0, y: 0 });
  const hoveredOpeningRef = useRef<{ wallIndex: number; ratioPosition: number; type: OpeningType } | null>(null);
  // 壁の予測位置（次の停止点）。draw モードのホバー中のみ set し、render で「窓/ドアと同様の」ハイライトを描く（260623）。
  const predictedWallPointRef = useRef<Point | null>(null);

  const BASE_SCALE = SKETCH_BASE_SCALE;
  const rulerSize = 34; // pixels

  const DEFAULT_ZOOM = 0.08;
  const DEFAULT_OFFSET = { x: 80, y: 80 };

  const viewZoomRef = useRef(DEFAULT_ZOOM);
  const viewOffsetRef = useRef(DEFAULT_OFFSET);
  /** ホイールを1フレームにまとめてメインスレッド負荷を抑える */
  const wheelPendingZoomRef = useRef<number | null>(null);
  const wheelPendingOffsetRef = useRef<Point | null>(null);
  const wheelRafRef = useRef<number | null>(null);
  const canvas2dCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const pointsMmRef = useRef<Point[]>([]);
  const furnitureItemsRef = useRef<FurnitureItem[]>(furnitureItems);
  // 複数選択（store.selectedIds）を RAF 描画ループから読むための購読＋ref（260623・Cフェーズ2）。
  const selectedIds = useStore(useProjectStore, (s) => s.selectedIds);
  const selectedIdsRef = useRef<string[]>(selectedIds);
  selectedIdsRef.current = selectedIds;

  /** 家具ドラッグ／回転は ref のみ更新し pointerup で React へ1回コミット（pointermove 毎の setState を避ける） */
  type FurnitureInteractionPreview =
    | { kind: 'move'; id: string; centerMm: Point }
    | { kind: 'rotate'; id: string; yaw: number };
  const furnitureInteractionPreviewRef = useRef<FurnitureInteractionPreview | null>(null);
  /** 家具ホバー時の resolveFurnitureHit を間引く（直近サンプル位置） */
  const lastFurnitureHoverCursorRef = useRef<Point | null>(null);
  /** 選択家具の回転リング上のみホバー（描画ハイライト用） */
  const furnitureRingHoverRef = useRef(false);

  /** ズームアウト時の描画ループ暴走を防ぐ */
  const MAX_VIEW_GRID_ITER = 600;

  const [pointsMm, setPointsMm] = useState<Point[]>(() => {
    const initial = initialPoints && initialPoints.length > 0 
      ? initialPoints.map(p => ({ x: p.x / BASE_SCALE, y: p.y / BASE_SCALE }))
      : [];
    pointsMmRef.current = initial;
    return initial;
  });

  // Sync state to ref
  useEffect(() => {
    pointsMmRef.current = pointsMm;
  }, [pointsMm]);

  useEffect(() => {
    furnitureItemsRef.current = furnitureItems;
  }, [furnitureItems]);

  const [isDrawing, setIsDrawing] = useState(false);
  const [isClosed, setIsClosed] = useState(pointsMm.length >= 3);
  const isClosedRef = useRef(isClosed);
  isClosedRef.current = isClosed;
  const [isGridSnapEnabled, setIsGridSnapEnabled] = useState(true);
  // 寸法/頂点スナップ（既存ジオメトリの頂点・X/Y整列に吸着）。
  const [isVertexSnapEnabled, setIsVertexSnapEnabled] = useState(true);
  // 下絵スナップ（背景画像の枠・辺・中心へ吸着）。既定OFF・任意。
  const [isUnderlaySnapEnabled, setIsUnderlaySnapEnabled] = useState(false);
  
  // Selection & Interaction State
  const [draggingPointIndex, setDraggingPointIndex] = useState<number | null>(null);
  const [draggingEdgeIndex, setDraggingEdgeIndex] = useState<number | null>(null);
  const [draggingOpeningId, setDraggingOpeningId] = useState<string | null>(null);
  const [draggingFurnitureId, setDraggingFurnitureId] = useState<string | null>(null);
  const [rotatingFurnitureId, setRotatingFurnitureId] = useState<string | null>(null);
  const [furnitureHint, setFurnitureHint] = useState<string | null>(null);
  // 左サイドツールパネル: lg未満ではドロワー化（既定で隠す）。lg以上は常時表示（この状態は無視）。
  const [panelOpen, setPanelOpen] = useState(false);
  const confirm = useConfirm();
  const furnitureHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rotationWallOkRef = useRef(true);
  /** リング回転ドラッグ開始時の yaw とマウス角度（絶対スナップでは掴み位置が飛ぶため相対で更新） */
  const furnitureRotateDragStartRef = useRef<{
    id: string;
    yaw0: number;
    sketchAngle0: number;
  } | null>(null);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [selectedEdgeIndex, setSelectedEdgeIndex] = useState<number | null>(null);
  const GIZMO_ARM_BASE_PX = 20;
  const GIZMO_HEAD_BASE_PX = 6;
  const GIZMO_STROKE_BASE_PX = 2;
  const GIZMO_OFFSET_BASE_PX = 9;
  const OPENING_ARROW_NORMAL_OFFSET_BASE_PX = 13;
  /** 壁からの「飛び出し」：寸法ラベル・壁辺ギズモを同系で外側へ */
  const WALL_EDGE_OUTSET_BASE_PX = 14;
  const EDGE_DIM_OUTSET_EXTRA_BASE_PX = 26;
  /** リングヒット：弧付近のみ。内側の広い誤検出を減らす非対称帯 */
  const RING_HIT_INNER_PX = 6;
  const RING_HIT_OUTER_PX = 12;

  const FURNITURE_ROTATION_SNAP_RAD = (10 * Math.PI) / 180;
  
  const [isPanning, setIsPanning] = useState(false);
  const lastMousePixelsRef = useRef<Point | null>(null);
  const isSelectMode = toolMode === 'select';
  const isDrawMode = toolMode === 'draw';
  const isAddDoor = toolMode === 'add' && addKind === 'door';
  const isAddWindow = toolMode === 'add' && addKind === 'window';
  const isAddFurniture = toolMode === 'add' && addKind === 'furniture';
  const isBeamMode = toolMode === 'beam';
  // draw モードを抜けたら予測位置マーカーを消す（モード切替直後にホバーが残らないように・260623）。
  useEffect(() => {
    if (toolMode !== 'draw') predictedWallPointRef.current = null;
  }, [toolMode]);

  // キャンバスは利用可能領域いっぱいにレスポンシブ表示する。getCanvasMousePos は表示矩形を
  // そのまま座標に使うため、属性サイズ(=canvasSize)を実表示サイズ（コンテナ）に一致させる。
  const [canvasSize, setCanvasSize] = useState({ width: 1100, height: 740 });
  useEffect(() => {
    const el = canvasBoxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(320, Math.floor(entry.contentRect.width));
        const h = Math.max(240, Math.floor(entry.contentRect.height));
        setCanvasSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 上部ツールバーが最上段(md以上: top-6)にあるとき、その実測下端を共有ストアへ。
  // 別ツリーの UndoRedoBar / ホームボタンがその直下へ退避し、最上段ツールバーと重ならないようにする。
  // 下段(top-[136px], md未満)のときは rect.top が大きいので 0 を入れ、従来位置のままにする。
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = toolbarRef.current;
    const setBottom = useRenderOverlayStore.getState().setSketchToolbarBottom;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      // top が小さい＝最上段(top-6)に上げた状態のときだけ、下端を通知（退避を有効化）。
      setBottom(rect.top < 100 ? Math.round(rect.bottom) : 0);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      setBottom(0);
    };
  }, []);

  const { centerMm } = getRoomTransform(pointsMm.map((p) => ({ x: mmToScaled(p.x), y: mmToScaled(p.y) })));

  const screenToWorld = useCallback((px: Point) => ({
    x: (px.x - viewOffsetRef.current.x) / viewZoomRef.current,
    y: (px.y - viewOffsetRef.current.y) / viewZoomRef.current
  }), []);

  const worldToScreen = useCallback((mm: Point) => ({
    x: mm.x * viewZoomRef.current + viewOffsetRef.current.x,
    y: mm.y * viewZoomRef.current + viewOffsetRef.current.y
  }), []);

  // --- 下絵（背景画像）---
  // 画像は ref に保持し、rAF の render ループ内で毎フレーム読み出す（再描画トリガ不要）。
  const underlayFileInputRef = useRef<HTMLInputElement | null>(null);
  const underlayImgRef = useRef<HTMLImageElement | null>(null);
  const underlayRef = useRef(underlay);
  underlayRef.current = underlay;
  // 画像のピクセル寸法（キャリブレーションの「幅(mm)」計算に使うため state で保持）。
  const [underlayImgSize, setUnderlayImgSize] = useState<{ w: number; h: number } | null>(null);
  // 下絵をマウスドラッグで移動するモード（数値入力と併用）。
  const [underlayMoveMode, setUnderlayMoveMode] = useState(false);
  const underlayMoveModeRef = useRef(underlayMoveMode);
  underlayMoveModeRef.current = underlayMoveMode;
  const draggingUnderlayRef = useRef(false);
  const underlayDragStartRef = useRef<{ mm: Point; offsetX: number; offsetY: number } | null>(null);
  // 下絵リサイズ（右下角ハンドルのドラッグで等比拡縮）。
  const resizingUnderlayRef = useRef(false);
  const underlayResizeStartRef = useRef<{ imgW: number } | null>(null);

  useEffect(() => {
    if (!underlay?.dataUrl) {
      underlayImgRef.current = null;
      setUnderlayImgSize(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      underlayImgRef.current = img;
      setUnderlayImgSize({ w: img.width, h: img.height });
    };
    img.src = underlay.dataUrl;
    return () => {
      img.onload = null;
    };
  }, [underlay?.dataUrl]);

  const handleUnderlayFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      // データ容量制限（仕様）: 10MB 超は拒否。
      if (file.size > 10 * 1024 * 1024) {
        showFurnitureHint('下絵ファイルが大きすぎます（10MB以下にしてください）');
        return;
      }
      try {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        let dataUrl: string;
        if (isPdf) {
          // pdfjs を動的 import（PDF 選択時のみ読み込み）して1ページ目をラスタライズ。
          const { pdfFirstPageToDataUrl } = await import('../utils/pdfToImage.js');
          dataUrl = await pdfFirstPageToDataUrl(file);
        } else {
          dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
        }
        if (!dataUrl) return;
        onUnderlayChange?.({ dataUrl, opacity: 0.5, scaleMmPerPx: 10, offsetX: 0, offsetY: 0, visible: true });
      } catch (err) {
        console.error('[underlay] failed to load', err);
        showFurnitureHint('下絵の読み込みに失敗しました');
      }
    },
    // showFurnitureHint は安定（useCallback []）のため依存に含めない。
    [onUnderlayChange]
  );

  // --- 梁 / 天伏ビュー ---
  // render ループ（rAF）から毎フレーム読み出すため ref に保持する。
  const beamsRef = useRef(beams);
  beamsRef.current = beams;
  // 平面図/天伏図モードは App が保持（prop）。render ループからは ref 経由で読む。
  const ceilingViewRef = useRef(isCeilingView);
  ceilingViewRef.current = isCeilingView;
  // 非アクティブ図面（平面 or 天伏）のグレースケール表示時の透明度（下絵と同様に調整可）。
  const [inactiveLayerOpacity, setInactiveLayerOpacity] = useState(0.3);
  const inactiveOpacityRef = useRef(inactiveLayerOpacity);
  inactiveOpacityRef.current = inactiveLayerOpacity;
  const [selectedBeamId, setSelectedBeamId] = useState<string | null>(null);
  const selectedBeamIdRef = useRef(selectedBeamId);
  selectedBeamIdRef.current = selectedBeamId;
  // 自由梁の直接ドラッグ（移動/回転）状態。壁梁は壁固定のため対象外。
  const beamDragRef = useRef<{ id: string; mode: 'move' | 'rotate'; startMm: Point; startCx: number; startCy: number } | null>(null);

  const addBeam = useCallback(() => {
    const id = `beam-${Date.now()}`;
    const beam: Beam = { id, cx: 0, cy: 0, lengthMm: 3000, angleDeg: 0, widthMm: 150, dropMm: 0, heightMm: 300 };
    onBeamsChange?.([...beamsRef.current, beam]);
    setSelectedBeamId(id);
    onCeilingViewChange?.(true);
  }, [onBeamsChange, onCeilingViewChange]);

  const updateBeam = useCallback(
    (id: string, patch: Partial<Beam>) => {
      onBeamsChange?.(beamsRef.current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    },
    [onBeamsChange]
  );

  const removeBeam = useCallback(
    (id: string) => {
      onBeamsChange?.(beamsRef.current.filter((b) => b.id !== id));
      setSelectedBeamId((cur) => (cur === id ? null : cur));
    },
    [onBeamsChange]
  );

  const showFurnitureHint = useCallback((msg: string) => {
    if (furnitureHintTimerRef.current) clearTimeout(furnitureHintTimerRef.current);
    setFurnitureHint(msg);
    furnitureHintTimerRef.current = setTimeout(() => {
      setFurnitureHint(null);
      furnitureHintTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(
    () => () => {
      if (furnitureHintTimerRef.current) clearTimeout(furnitureHintTimerRef.current);
    },
    []
  );

  const getFurniturePoseMm = (item: FurnitureItem) => {
    const center = furniturePositionToMm(item.position, centerMm);
    const yaw = item.rotation[1] || 0;
    return { center, yaw };
  };

  /** RAF 描画用: ドラッグ／回転プレビューをマージ */
  const getFurniturePoseMmForDraw = (item: FurnitureItem) => {
    const base = getFurniturePoseMm(item);
    const pv = furnitureInteractionPreviewRef.current;
    if (pv && pv.id === item.id) {
      if (pv.kind === 'move') return { center: pv.centerMm, yaw: base.yaw };
      if (pv.kind === 'rotate') return { center: base.center, yaw: pv.yaw };
    }
    return base;
  };

  const hitTestFurnitureItem = (mm: Point, item: FurnitureItem) => {
    const { center, yaw } = getFurniturePoseMm(item);
    const { width, depth } = getFurnitureFootprintMm(item);
    const dx = mm.x - center.x;
    const dy = mm.y - center.y;
    const cos = Math.cos(-yaw);
    const sin = Math.sin(-yaw);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return Math.abs(localX) <= width / 2 && Math.abs(localY) <= depth / 2;
  };

  const hitTestFurniture = (mm: Point) => {
    for (let i = furnitureItems.length - 1; i >= 0; i -= 1) {
      const item = furnitureItems[i];
      if (hitTestFurnitureItem(mm, item)) return item;
    }
    return null;
  };

  const hitTestFurnitureRotationRing = (pixels: Point, item: FurnitureItem) => {
    const pose = getFurniturePoseMm(item);
    const centerPx = worldToScreen(pose.center);
    const { width, depth } = getFurnitureFootprintMm(item);
    const z = viewZoomRef.current;
    const ringR = getFurnitureRotationRingRadiusPx(width, depth, z);
    const dist = Math.hypot(pixels.x - centerPx.x, pixels.y - centerPx.y);
    return dist >= ringR - RING_HIT_INNER_PX && dist <= ringR + RING_HIT_OUTER_PX;
  };

  /** 足跡 or 回転リングのどちらかに当たる最前面の家具（リングのみでも拾う） */
  const resolveFurnitureHit = (mm: Point, pixels: Point): FurnitureItem | null => {
    for (let i = furnitureItems.length - 1; i >= 0; i -= 1) {
      const item = furnitureItems[i];
      if (hitTestFurnitureRotationRing(pixels, item) || hitTestFurnitureItem(mm, item)) {
        return item;
      }
    }
    return null;
  };

  const hitTestOpeningBody = (mm: Point) => {
    for (const op of openings) {
      const wall = getWallSegment(pointsMm, op.wallIndex);
      if (!wall) continue;
      const wallDir = { x: wall.dx / wall.length, y: wall.dy / wall.length };
      const perpDir = { x: -wallDir.y, y: wallDir.x };
      const opCenterMm = lerpPoint(wall.p1, wall.p2, op.ratioPosition);
      const mouseVec = { x: mm.x - opCenterMm.x, y: mm.y - opCenterMm.y };
      const parallelDist = mouseVec.x * wallDir.x + mouseVec.y * wallDir.y;
      const perpDist = Math.abs(mouseVec.x * perpDir.x + mouseVec.y * perpDir.y);
      if (Math.abs(parallelDist) <= op.width / 2 && perpDist <= 300) return op.id;
    }
    return null;
  };

  const hitTestPoint = (pixels: Point) => {
    const hitR = Math.max(10, Math.min(18, 12 * getArrowGizmoScale(viewZoomRef.current)));
    return pointsMm.findIndex((p) => {
      const pScreen = worldToScreen(p);
      return Math.hypot(pScreen.x - pixels.x, pScreen.y - pixels.y) < hitR;
    });
  };

  const hitTestEdge = (pixels: Point) => {
    if (pointsMm.length < 2) return null;
    const edgeCount = isClosed ? pointsMm.length : pointsMm.length - 1;
    for (let i = 0; i < edgeCount; i++) {
      const p1 = worldToScreen(pointsMm[i]);
      const p2 = worldToScreen(pointsMm[(i + 1) % pointsMm.length]);
      const l2 = (p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2;
      let t = ((pixels.x - p1.x) * (p2.x - p1.x) + (pixels.y - p1.y) * (p2.y - p1.y)) / l2;
      t = Math.max(0, Math.min(1, t));
      const dist = Math.hypot(pixels.x - (p1.x + t * (p2.x - p1.x)), pixels.y - (p1.y + t * (p2.y - p1.y)));
      const edgeHitPx = Math.max(8, Math.min(14, 10 * getArrowGizmoScale(viewZoomRef.current)));
      if (dist < edgeHitPx) return i;
    }
    return null;
  };

  const snapValue = (val: number, step: number) => Math.round(val / step) * step;

  const getSnappedMm = (rawMm: Point, originMm?: Point): Point => {
    // Priority 1: Snap to Start Point (Red Point) if closing loop
    // This takes precedence over all other snaps
    if (pointsMm.length >= 3 && !isClosed) {
        const startPt = pointsMm[0];
        const startScreen = worldToScreen(startPt);
        const rawScreen = worldToScreen(rawMm);
        const distPx = Math.hypot(startScreen.x - rawScreen.x, startScreen.y - rawScreen.y);
        
        // 20px threshold for magnetic snap
        if (distPx < 20) {
            return startPt;
        }
    }

    // Priority 2: 寸法/頂点スナップ（既存ジオメトリへの吸着）
    if (isVertexSnapEnabled && pointsMm.length > 0) {
      const rawScreen = worldToScreen(rawMm);
      const VERTEX_PX = 14;
      // 2a. 既存頂点への吸着（自分の起点は除外）
      for (const v of pointsMm) {
        if (originMm && v.x === originMm.x && v.y === originMm.y) continue;
        const vs = worldToScreen(v);
        if (Math.hypot(vs.x - rawScreen.x, vs.y - rawScreen.y) < VERTEX_PX) {
          return { x: v.x, y: v.y };
        }
      }
      // 2b. X/Y 整列スナップ（既存頂点と同じ X もしくは Y に揃える）
      let snappedX = rawMm.x;
      let snappedY = rawMm.y;
      let alignedX = false;
      let alignedY = false;
      for (const v of pointsMm) {
        if (originMm && v.x === originMm.x && v.y === originMm.y) continue;
        const vs = worldToScreen(v);
        if (!alignedX && Math.abs(vs.x - rawScreen.x) < VERTEX_PX) { snappedX = v.x; alignedX = true; }
        if (!alignedY && Math.abs(vs.y - rawScreen.y) < VERTEX_PX) { snappedY = v.y; alignedY = true; }
        if (alignedX && alignedY) break;
      }
      if (alignedX || alignedY) {
        // 整列しない軸はグリッドが有効なら従来どおりグリッドへ。
        if (!alignedX && isGridSnapEnabled && gridSize > 0) snappedX = snapValue(rawMm.x, gridSize);
        if (!alignedY && isGridSnapEnabled && gridSize > 0) snappedY = snapValue(rawMm.y, gridSize);
        return { x: snappedX, y: snappedY };
      }
    }

    // Priority 2.5: 下絵スナップ（背景画像の枠の角・辺中点・中心へ吸着 / 枠の縦横ラインへ整列）
    if (isUnderlaySnapEnabled && underlayRef.current?.visible && underlayImgRef.current) {
      const ul = underlayRef.current;
      const img = underlayImgRef.current;
      const mmPerPx = ul.scaleMmPerPx && ul.scaleMmPerPx > 0 ? ul.scaleMmPerPx : 10;
      const x0 = ul.offsetX;
      const y0 = ul.offsetY;
      const x1 = x0 + img.width * mmPerPx;
      const y1 = y0 + img.height * mmPerPx;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const rawScreen = worldToScreen(rawMm);
      const UL_PX = 14;
      // 角・辺中点・中心の9点へ吸着
      const pts: Point[] = [
        { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 },
        { x: mx, y: y0 }, { x: mx, y: y1 }, { x: x0, y: my }, { x: x1, y: my }, { x: mx, y: my },
      ];
      for (const t of pts) {
        const ts = worldToScreen(t);
        if (Math.hypot(ts.x - rawScreen.x, ts.y - rawScreen.y) < UL_PX) return { x: t.x, y: t.y };
      }
      // 枠の縦/横ライン（左/中/右・上/中/下）へ軸ごとに整列
      let sx = rawMm.x;
      let sy = rawMm.y;
      let ax = false;
      let ay = false;
      for (const X of [x0, mx, x1]) {
        if (!ax && Math.abs(worldToScreen({ x: X, y: rawMm.y }).x - rawScreen.x) < UL_PX) { sx = X; ax = true; }
      }
      for (const Y of [y0, my, y1]) {
        if (!ay && Math.abs(worldToScreen({ x: rawMm.x, y: Y }).y - rawScreen.y) < UL_PX) { sy = Y; ay = true; }
      }
      if (ax || ay) return { x: sx, y: sy };
    }

    // Priority 3: Grid Snap (Absolute Coordinate Snap)
    // If Grid Snap is ON, strictly snap to grid intersections defined by gridSize.
    if (isGridSnapEnabled && gridSize > 0) {
       return { 
         x: snapValue(rawMm.x, gridSize), 
         y: snapValue(rawMm.y, gridSize) 
       };
    }

    // Priority 3: Relative Length/Angle Snap
    if (!originMm) {
      // Even if Grid Snap is OFF, applying Length Snap to the first point makes little sense relative to origin (0,0)
      // unless we treat the world origin as a reference, but usually the first point is free or grid snapped.
      return rawMm;
    }
    
    const dx = rawMm.x - originMm.x;
    const dy = rawMm.y - originMm.y;
    const rawLen = Math.sqrt(dx * dx + dy * dy);
    const rawAngle = Math.atan2(dy, dx);
    
    let finalAngle = rawAngle;
    if (isAngleSnapEnabled && angleSnap > 0) {
      const snapRad = (angleSnap * Math.PI) / 180;
      finalAngle = Math.round(rawAngle / snapRad) * snapRad;
    }
    
    let finalLen = rawLen;
    // Use lengthSnapSize for relative length snapping
    if (isLengthSnapEnabled && lengthSnapSize > 0) {
      finalLen = snapValue(rawLen, lengthSnapSize);
    }
    
    return {
      x: originMm.x + Math.cos(finalAngle) * finalLen,
      y: originMm.y + Math.sin(finalAngle) * finalLen
    };
  };

  useEffect(() => {
    const legacyPoints = pointsMm.map(p => ({ x: p.x * BASE_SCALE, y: p.y * BASE_SCALE }));
    onSketchUpdate(legacyPoints, isClosed);
  }, [pointsMm, isClosed]);

  const getCanvasMousePos = (e: any): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX =
      e.touches && e.touches[0]
        ? e.touches[0].clientX
        : e.changedTouches && e.changedTouches[0]
          ? e.changedTouches[0].clientX
          : e.clientX;
    const clientY =
      e.touches && e.touches[0]
        ? e.touches[0].clientY
        : e.changedTouches && e.changedTouches[0]
          ? e.changedTouches[0].clientY
          : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const releasePointerCaptureSafe = () => {
    const canvas = canvasRef.current;
    const id = pointerCaptureIdRef.current;
    if (canvas != null && id != null) {
      try {
        if (typeof canvas.hasPointerCapture === 'function' && canvas.hasPointerCapture(id)) {
          canvas.releasePointerCapture(id);
        }
      } catch {
        /* ignore */
      }
    }
    pointerCaptureIdRef.current = null;
  };

  const tryPointerCapture = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
      pointerCaptureIdRef.current = e.pointerId;
    } catch {
      pointerCaptureIdRef.current = null;
    }
  };

  const getFigureCenter = useCallback(() => {
    if (pointsMm.length === 0) {
        return screenToWorld({ x: canvasSize.width / 2, y: canvasSize.height / 2 });
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pointsMm.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    });
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }, [pointsMm, canvasSize, screenToWorld]);

  const clampViewOffset = (o: Point): Point => {
    const M = 5e7;
    return {
      x: Math.max(-M, Math.min(M, Number.isFinite(o.x) ? o.x : 0)),
      y: Math.max(-M, Math.min(M, Number.isFinite(o.y) ? o.y : 0))
    };
  };

  const handleZoomButton = (direction: 'in' | 'out') => {
    const center = getFigureCenter();
    const factor = direction === 'in' ? 1.2 : 1 / 1.2;
    const minZ = computeMinZoomForFloorplan(pointsMm, canvasSize.width, canvasSize.height);
    const newZoom = Math.max(minZ, Math.min(GLOBAL_ZOOM_MAX, viewZoomRef.current * factor));
    const canvasCenter = { x: canvasSize.width / 2, y: canvasSize.height / 2 };
    const newOffsetX = canvasCenter.x - center.x * newZoom;
    const newOffsetY = canvasCenter.y - center.y * newZoom;
    if (!Number.isFinite(newZoom) || !Number.isFinite(newOffsetX) || !Number.isFinite(newOffsetY)) return;
    viewZoomRef.current = newZoom;
    viewOffsetRef.current = clampViewOffset({ x: newOffsetX, y: newOffsetY });
  };

  const handleFitToScreen = () => {
    if (pointsMm.length === 0) {
        viewZoomRef.current = DEFAULT_ZOOM;
        viewOffsetRef.current = DEFAULT_OFFSET;
        return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pointsMm.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    });
    const padding = 1000;
    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;
    const zoomX = canvasSize.width / width;
    const zoomY = canvasSize.height / height;
    const newZoom = Math.min(zoomX, zoomY, 2.0);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const canvasCenter = { x: canvasSize.width / 2, y: canvasSize.height / 2 };
    if (!Number.isFinite(newZoom) || !Number.isFinite(centerX) || !Number.isFinite(centerY)) return;
    viewZoomRef.current = newZoom;
    viewOffsetRef.current = clampViewOffset({
      x: canvasCenter.x - centerX * newZoom,
      y: canvasCenter.y - centerY * newZoom
    });
  };

  const handleDeleteSelected = () => {
    if (activeFurnitureId) {
      onFurnitureUpdate((prev) => prev.filter((item) => item.id !== activeFurnitureId));
      onFurnitureSelect(null);
    } else if (selectedPointIndex !== null) {
        // Delete Point
        setPointsMm(prev => {
            const next = prev.filter((_, i) => i !== selectedPointIndex);
            if (next.length < 3) setIsClosed(false);
            return next;
        });
        setSelectedPointIndex(null);
    } else if (selectedEdgeIndex !== null) {
        // Delete Edge
        setPointsMm(prev => {
            const next = prev.filter((_, i) => i !== selectedEdgeIndex);
            if (next.length < 3) setIsClosed(false);
            return next;
        });
        setSelectedEdgeIndex(null);
    } else {
        // Fallback: Delete last point if nothing selected (old Undo behavior)
        if (isClosed) {
            setIsClosed(false);
            setIsDrawing(true);
        } else {
            setPointsMm(prev => prev.slice(0, -1));
        }
    }
  };

  // 2D固有の選択（頂点・辺・梁）の Delete / Backspace 削除。
  // 建具・家具は App 側の統合ハンドラが2D/3D両方で処理するため、ここでは扱わない（重複削除を避ける）。
  // 入力欄フォーカス中は無効。SketchCanvas は2Dビュー時のみマウントされる。
  useEffect(() => {
    const isTypingTarget = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (isTypingTarget()) return;
      if (selectedPointIndex !== null) {
        e.preventDefault();
        setPointsMm((prev) => {
          const next = prev.filter((_, i) => i !== selectedPointIndex);
          if (next.length < 3) setIsClosed(false);
          return next;
        });
        setSelectedPointIndex(null);
      } else if (selectedEdgeIndex !== null) {
        e.preventDefault();
        setPointsMm((prev) => {
          const next = prev.filter((_, i) => i !== selectedEdgeIndex);
          if (next.length < 3) setIsClosed(false);
          return next;
        });
        setSelectedEdgeIndex(null);
      } else if (selectedBeamId) {
        e.preventDefault();
        onBeamsChange?.(beams.filter((b) => b.id !== selectedBeamId));
        setSelectedBeamId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPointIndex, selectedEdgeIndex, selectedBeamId, beams, onBeamsChange]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pixels = getCanvasMousePos(e);
    if (pixels.x < rulerSize || pixels.y < rulerSize) return;
    const mm = screenToWorld(pixels);
    const furnitureHit = resolveFurnitureHit(mm, pixels);
    if (e.button === 2 || e.shiftKey) {
      setIsPanning(true);
      lastMousePixelsRef.current = pixels;
      tryPointerCapture(e);
      return;
    }

    // --- 下絵 リサイズ: 右下角ハンドルを掴んだら拡縮（移動判定より先に評価） ---
    if (
      underlayMoveModeRef.current &&
      e.button !== 2 &&
      underlayRef.current?.visible &&
      underlayImgRef.current
    ) {
      const ul = underlayRef.current;
      const img = underlayImgRef.current;
      const mmPerPx = ul.scaleMmPerPx && ul.scaleMmPerPx > 0 ? ul.scaleMmPerPx : 10;
      const br = worldToScreen({
        x: ul.offsetX + img.width * mmPerPx,
        y: ul.offsetY + img.height * mmPerPx,
      });
      if (Math.hypot(pixels.x - br.x, pixels.y - br.y) <= 12) {
        resizingUnderlayRef.current = true;
        underlayResizeStartRef.current = { imgW: img.width };
        lastMousePixelsRef.current = pixels;
        tryPointerCapture(e);
        return;
      }
    }

    // --- 下絵 移動モード: 左ドラッグで下絵を平行移動（他のツール操作には干渉しない） ---
    if (
      underlayMoveModeRef.current &&
      e.button !== 2 &&
      underlayRef.current?.visible &&
      underlayImgRef.current
    ) {
      draggingUnderlayRef.current = true;
      underlayDragStartRef.current = {
        mm,
        offsetX: underlayRef.current.offsetX,
        offsetY: underlayRef.current.offsetY,
      };
      lastMousePixelsRef.current = pixels;
      tryPointerCapture(e);
      return;
    }

    // --- 天伏図: 既存の自由梁を選択/移動/回転（壁梁は壁固定のため対象外） ---
    if (isCeilingView && (isSelectMode || isBeamMode)) {
      // 回転ハンドル（選択中の自由梁の端の先）にヒットしたら回転開始。
      const sel = beamsRef.current.find(
        (b) => b.id === selectedBeamIdRef.current && b.wallIndex === undefined,
      );
      if (sel) {
        const rad = (sel.angleDeg * Math.PI) / 180;
        const hd = sel.lengthMm / 2 + 600;
        const hPx = worldToScreen({ x: sel.cx + hd * Math.cos(rad), y: sel.cy + hd * Math.sin(rad) });
        if (Math.hypot(pixels.x - hPx.x, pixels.y - hPx.y) <= 12) {
          beamDragRef.current = { id: sel.id, mode: 'rotate', startMm: mm, startCx: sel.cx, startCy: sel.cy };
          tryPointerCapture(e);
          return;
        }
      }
      // 自由梁の本体にヒットしたら選択＋移動開始。
      for (const b of beamsRef.current) {
        if (b.wallIndex !== undefined) continue;
        const rad = (b.angleDeg * Math.PI) / 180;
        const dx = mm.x - b.cx;
        const dy = mm.y - b.cy;
        const lx = dx * Math.cos(rad) + dy * Math.sin(rad);
        const ly = -dx * Math.sin(rad) + dy * Math.cos(rad);
        if (Math.abs(lx) <= b.lengthMm / 2 && Math.abs(ly) <= b.widthMm / 2) {
          setSelectedBeamId(b.id);
          beamDragRef.current = { id: b.id, mode: 'move', startMm: mm, startCx: b.cx, startCy: b.cy };
          tryPointerCapture(e);
          return;
        }
      }
    }

    // --- 梁モード: 壁にスナップして壁梁、空きスペースなら自由梁を配置 ---
    if (isBeamMode) {
      const edgeCount = isClosed ? pointsMm.length : Math.max(0, pointsMm.length - 1);
      let bestWall = -1;
      let bestDist = Infinity;
      for (let i = 0; i < edgeCount; i++) {
        const w = getWallSegment(pointsMm, i);
        if (!w) continue;
        const l2 = w.length * w.length || 1;
        let t = ((mm.x - w.p1.x) * w.dx + (mm.y - w.p1.y) * w.dy) / l2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(mm.x - (w.p1.x + t * w.dx), mm.y - (w.p1.y + t * w.dy));
        if (d < bestDist) {
          bestDist = d;
          bestWall = i;
        }
      }
      const snapThresholdMm = 25 / Math.max(viewZoomRef.current, 1e-6);
      const id = `beam-${Date.now()}`;
      const wallSeg = bestWall >= 0 && bestDist <= snapThresholdMm ? getWallSegment(pointsMm, bestWall) : null;
      const beam: Beam = wallSeg
        ? {
            id,
            cx: (wallSeg.p1.x + wallSeg.p2.x) / 2,
            cy: (wallSeg.p1.y + wallSeg.p2.y) / 2,
            lengthMm: wallSeg.length,
            angleDeg: (Math.atan2(wallSeg.dy, wallSeg.dx) * 180) / Math.PI,
            widthMm: 150,
            dropMm: 0,
            heightMm: 300,
            wallIndex: bestWall,
          }
        : { id, cx: mm.x, cy: mm.y, lengthMm: 2000, angleDeg: 0, widthMm: 150, dropMm: 0, heightMm: 300 };
      onBeamsChange?.([...beamsRef.current, beam]);
      setSelectedBeamId(id);
      return;
    }

    // --- SELECT MODE ---
    if (isSelectMode || isAddFurniture) {
      if (furnitureHit) {
        // shift / ctrl / cmd 押下時は複数選択（トグル）。それ以外は単一選択（260623・Cフェーズ2）。
        onFurnitureSelect(furnitureHit.id, e.shiftKey || e.ctrlKey || e.metaKey);
        onOpeningSelect(null);
        setSelectedPointIndex(null);
        setSelectedEdgeIndex(null);
        const onBody = hitTestFurnitureItem(mm, furnitureHit);
        const onRing = hitTestFurnitureRotationRing(pixels, furnitureHit);
        let startedInteraction = false;
        if (onRing) {
          const fItem = furnitureItems.find((f) => f.id === furnitureHit.id);
          if (fItem) {
            const pose = getFurniturePoseMm(fItem);
            furnitureRotateDragStartRef.current = {
              id: fItem.id,
              yaw0: fItem.rotation[1] || 0,
              sketchAngle0: Math.atan2(mm.y - pose.center.y, mm.x - pose.center.x)
            };
          }
          setRotatingFurnitureId(furnitureHit.id);
          startedInteraction = true;
        } else if (onBody) {
          setDraggingFurnitureId(furnitureHit.id);
          startedInteraction = true;
        }
        if (startedInteraction) {
          lastMousePixelsRef.current = pixels;
          tryPointerCapture(e);
        }
        return;
      }

      if (isAddFurniture) {
        onFurnitureSelect(null);
      }

      // 0. Check Opening Hit (PRIORITIZED)
      let openingHit = false;
      if (openings.length > 0) {
        for (const op of openings) {
          const wall = getWallSegment(pointsMm, op.wallIndex);
          if (!wall) continue;
          const wallDir = { x: wall.dx / wall.length, y: wall.dy / wall.length };
          const perpDir = { x: -wallDir.y, y: wallDir.x };
          const opCenterMm = lerpPoint(wall.p1, wall.p2, op.ratioPosition);

          const mouseVec = { x: mm.x - opCenterMm.x, y: mm.y - opCenterMm.y };

          const parallelDist = mouseVec.x * wallDir.x + mouseVec.y * wallDir.y;
          const perpDist = Math.abs(mouseVec.x * perpDir.x + mouseVec.y * perpDir.y);
          
          const halfWidth = op.width / 2;
          const hitThreshold = 300; // 30cm perpendicular tolerance
          if (Math.abs(parallelDist) <= halfWidth && perpDist <= hitThreshold) {
            onOpeningSelect(op.id);
            setSelectedPointIndex(null);
            setSelectedEdgeIndex(null);
            onFurnitureSelect(null);
            setDraggingOpeningId(op.id);
            lastMousePixelsRef.current = pixels;
            tryPointerCapture(e);
            openingHit = true;
            break; 
          }
        }
      }
      if (openingHit) return;

      // 1. Check Point Hit
      const pointHitR = Math.max(10, Math.min(18, 12 * getArrowGizmoScale(viewZoomRef.current)));
      const foundPointIdx = pointsMm.findIndex(p => {
        const pScreen = worldToScreen(p);
        return Math.hypot(pScreen.x - pixels.x, pScreen.y - pixels.y) < pointHitR;
      });

      if (foundPointIdx !== -1) {
        setDraggingPointIndex(foundPointIdx);
        setSelectedPointIndex(foundPointIdx);
        setSelectedEdgeIndex(null);
        onOpeningSelect(null);
        onFurnitureSelect(null);
        lastMousePixelsRef.current = pixels;
        tryPointerCapture(e);
        return;
      }
      
      // 2. Check Edge Hit
      if (pointsMm.length >= 2) {
        const edgeHitPx = Math.max(8, Math.min(14, 10 * getArrowGizmoScale(viewZoomRef.current)));
        const edgeCount = isClosed ? pointsMm.length : pointsMm.length - 1;
        for (let i = 0; i < edgeCount; i++) {
          const p1 = worldToScreen(pointsMm[i]);
          const p2 = worldToScreen(pointsMm[(i + 1) % pointsMm.length]);
          const l2 = (p1.x - p2.x)**2 + (p1.y - p2.y)**2;
          let t = ((pixels.x - p1.x) * (p2.x - p1.x) + (pixels.y - p1.y) * (p2.y - p1.y)) / l2;
          t = Math.max(0, Math.min(1, t));
          const dist = Math.hypot(pixels.x - (p1.x + t * (p2.x - p1.x)), pixels.y - (p1.y + t * (p2.y - p1.y)));
          
          if (dist < edgeHitPx) {
            setDraggingEdgeIndex(i);
            setSelectedEdgeIndex(i);
            setSelectedPointIndex(null);
            onOpeningSelect(null);
            onFurnitureSelect(null);
            lastMousePixelsRef.current = pixels;
            tryPointerCapture(e);
            return;
          }
        }
      }

      // Clicked empty space in select mode
      setSelectedPointIndex(null);
      setSelectedEdgeIndex(null);
      onOpeningSelect(null);
      if (isSelectMode) onFurnitureSelect(null);
      return;
    }

    // --- WALL DRAW MODE ---
    if (isDrawMode) {
      if (isClosed) return;

      const lastPoint = pointsMm.length > 0 ? pointsMm[pointsMm.length - 1] : undefined;
      const snappedMm = getSnappedMm(mm, lastPoint);
      
      if (pointsMm.length >= 3 && snappedMm.x === pointsMm[0].x && snappedMm.y === pointsMm[0].y) {
         setIsClosed(true);
         setIsDrawing(false);
         return;
      }
      
      if (lastPoint && Math.hypot(snappedMm.x - lastPoint.x, snappedMm.y - lastPoint.y) < 10) return;

      setPointsMm(prev => [...prev, snappedMm]);
      setIsDrawing(true);
      return;
    }

    // --- OPENING ADD MODE ---
    if ((isAddDoor || isAddWindow) && pointsMm.length >= 2) {
      if (hoveredOpeningRef.current) {
        const { wallIndex, ratioPosition, type } = hoveredOpeningRef.current;
        
        const wall = getWallSegment(pointsMm, wallIndex);
        if (!wall) return;
        const wallLength = wall.length;

        const newOpening: Opening = {
          id: `opening-${Date.now()}`,
          type: type as any,
          wallIndex: wallIndex,
          ratioPosition: ratioPosition,
          width: type.startsWith('door') ? 900 : 1500,
          height: type.startsWith('door') ? 2100 : 1200,
          bottomOffset: type.startsWith('door') ? 0 : 900
        };

        const halfRatio = (getEffectiveOpeningWidthMm(newOpening) / 2) / wallLength;
        newOpening.ratioPosition = Math.max(halfRatio, Math.min(1 - halfRatio, newOpening.ratioPosition));

        setOpenings(prev => [...prev, newOpening]);
        // Continuous placement: Do not switch back to select mode
        // setToolMode('select');
        onOpeningSelect(newOpening.id);
        return;
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pixels = getCanvasMousePos(e);
    mousePosRef.current = pixels;
    const mm = screenToWorld(pixels);
    const canvas = canvasRef.current;

    // 下絵 リサイズドラッグ: 右下角の mm 位置から scaleMmPerPx を再計算（左上固定・等比）。
    if (resizingUnderlayRef.current && underlayResizeStartRef.current && underlayRef.current) {
      const ul = underlayRef.current;
      const newWidthMm = Math.max(100, mm.x - ul.offsetX);
      onUnderlayChange?.({ ...ul, scaleMmPerPx: newWidthMm / underlayResizeStartRef.current.imgW });
      if (canvas) canvas.style.cursor = 'nwse-resize';
      return;
    }

    // 下絵 移動ドラッグ: 開始点からのmm差分を offset に反映。
    if (draggingUnderlayRef.current && underlayDragStartRef.current && underlayRef.current) {
      const start = underlayDragStartRef.current;
      onUnderlayChange?.({
        ...underlayRef.current,
        offsetX: Math.round(start.offsetX + (mm.x - start.mm.x)),
        offsetY: Math.round(start.offsetY + (mm.y - start.mm.y)),
      });
      if (canvas) canvas.style.cursor = 'grabbing';
      return;
    }

    // 自由梁の移動/回転ドラッグ。
    if (beamDragRef.current) {
      const d = beamDragRef.current;
      if (d.mode === 'move') {
        // 自由梁は X/Y 制限なしで自由移動。さらに梁軸に沿って壁⇔壁へ長さを自動連動。
        const dx = mm.x - d.startMm.x;
        const dy = mm.y - d.startMm.y;
        const nextCx = d.startCx + dx;
        const nextCy = d.startCy + dy;
        const beam = beamsRef.current.find((x) => x.id === d.id);
        const span = beam
          ? computeWallToWallSpan(pointsMmRef.current, isClosedRef.current, nextCx, nextCy, beam.angleDeg)
          : null;
        updateBeam(
          d.id,
          span ? { cx: span.cx, cy: span.cy, lengthMm: span.lengthMm } : { cx: nextCx, cy: nextCy },
        );
      } else {
        updateBeam(d.id, { angleDeg: (Math.atan2(mm.y - d.startCy, mm.x - d.startCx) * 180) / Math.PI });
      }
      if (canvas) canvas.style.cursor = 'grabbing';
      return;
    }

    if (isPanning && lastMousePixelsRef.current) {
      viewOffsetRef.current = { 
        x: viewOffsetRef.current.x + (pixels.x - lastMousePixelsRef.current.x), 
        y: viewOffsetRef.current.y + (pixels.y - lastMousePixelsRef.current.y) 
      };
      lastMousePixelsRef.current = pixels;
      if (canvas) canvas.style.cursor = 'grabbing';
      return;
    }

    // Hover & Snap for Openings
    if ((isAddDoor || isAddWindow) && pointsMm.length >= 2) {
      let minDist = Infinity;
      let bestWall = -1;
      let bestRatio = 0.5;

      const edgeCount = isClosed ? pointsMm.length : pointsMm.length - 1;
      for (let i = 0; i < edgeCount; i++) {
        const wall = getWallSegment(pointsMm, i);
        if (!wall) continue;
        const l2 = wall.length * wall.length;
        if (l2 === 0) continue;
        let t = ((mm.x - wall.p1.x) * wall.dx + (mm.y - wall.p1.y) * wall.dy) / l2;
        t = Math.max(0, Math.min(1, t));
        const projected = lerpPoint(wall.p1, wall.p2, t);
        const dist = Math.hypot(mm.x - projected.x, mm.y - projected.y);
        if (dist < minDist) {
          minDist = dist;
          bestWall = i;
          bestRatio = t;
        }
      }

      if (bestWall !== -1 && minDist < 500) { // 500mm snap threshold
        hoveredOpeningRef.current = {
          wallIndex: bestWall,
          ratioPosition: bestRatio,
          type: isAddDoor ? 'door_single' : 'window_sliding'
        };
      } else {
        hoveredOpeningRef.current = null;
      }
    } else {
      hoveredOpeningRef.current = null;
    }

    // 壁の予測位置（次の停止点）を更新。draw モードのホバー位置をスナップして ref に保存し、
    // render 側で「窓/ドアと同様の」ハイライトを表示する（hoveredOpeningRef と同じ仕組み）。
    if (isDrawMode && !isClosed) {
      const originMm = pointsMm.length > 0 ? pointsMm[pointsMm.length - 1] : undefined;
      predictedWallPointRef.current = getSnappedMm(mm, originMm);
    } else {
      predictedWallPointRef.current = null;
    }

    if (rotatingFurnitureId) {
      const item = furnitureItems.find((f) => f.id === rotatingFurnitureId);
      if (item) {
        const pose = getFurniturePoseMm(item);
        const sketchAngle = Math.atan2(mm.y - pose.center.y, mm.x - pose.center.x);
        let start = furnitureRotateDragStartRef.current;
        if (!start || start.id !== item.id) {
          start = {
            id: item.id,
            yaw0: item.rotation[1] || 0,
            sketchAngle0: sketchAngle
          };
          furnitureRotateDragStartRef.current = start;
        }
        let yaw =
          start.yaw0 +
          sketchAngleToYaw(sketchAngle) -
          sketchAngleToYaw(start.sketchAngle0);
        yaw = Math.round(yaw / FURNITURE_ROTATION_SNAP_RAD) * FURNITURE_ROTATION_SNAP_RAD;
        const { width, depth } = getFurnitureFootprintMm(item);
        const canRotate =
          !isClosed || pointsMm.length < 3 || isFurnitureFootprintInsidePolygon(pose.center, yaw, width, depth, pointsMm);
        if (canRotate) {
          rotationWallOkRef.current = true;
          furnitureInteractionPreviewRef.current = { kind: 'rotate', id: rotatingFurnitureId, yaw };
        } else if (rotationWallOkRef.current) {
          showFurnitureHint('回転するには壁から離してください');
          rotationWallOkRef.current = false;
        }
      }
      if (canvas) canvas.style.cursor = 'grabbing';
    } else if (draggingFurnitureId) {
      const item = furnitureItems.find((f) => f.id === draggingFurnitureId);
      if (item) {
        let nextMm = mm;
        if (isClosed && pointsMm.length >= 3) {
          const { width, depth } = getFurnitureFootprintMm(item);
          const yaw = item.rotation[1] || 0;
          const prevCenter = furniturePositionToMm(item.position, centerMm);
          nextMm = slideFurnitureCenterMmWithWallContact(prevCenter, mm, yaw, width, depth, pointsMm);
        }
        furnitureInteractionPreviewRef.current = { kind: 'move', id: draggingFurnitureId, centerMm: nextMm };
      }
      if (canvas) canvas.style.cursor = 'grabbing';
    } else if (draggingPointIndex !== null) {
      const mm = screenToWorld(pixels);
      let referencePoint: Point | undefined = undefined;
      const prevIndex = (draggingPointIndex - 1 + pointsMm.length) % pointsMm.length;
      if (pointsMm.length > 1) referencePoint = pointsMm[prevIndex];
      const nextMm = getSnappedMm(mm, referencePoint);

      setPointsMm(prev => {
        const next = [...prev];
        next[draggingPointIndex] = nextMm;
        return next;
      });
      if (canvas) canvas.style.cursor = 'grabbing';
    } else if (draggingEdgeIndex !== null && lastMousePixelsRef.current) {
      const mmNow = screenToWorld(pixels);
      const mmLast = screenToWorld(lastMousePixelsRef.current);
      let dMmX = mmNow.x - mmLast.x;
      let dMmY = mmNow.y - mmLast.y;

      if (isGridSnapEnabled && gridSize > 0) {
         const p1 = pointsMm[draggingEdgeIndex];
         const newP1Raw = { x: p1.x + dMmX, y: p1.y + dMmY };
         const newP1Snapped = { x: snapValue(newP1Raw.x, gridSize), y: snapValue(newP1Raw.y, gridSize) };
         dMmX = newP1Snapped.x - p1.x;
         dMmY = newP1Snapped.y - p1.y;
      }

      if (Math.abs(dMmX) > 0.01 || Math.abs(dMmY) > 0.01) {
        setPointsMm(prev => {
          const next = [...prev];
          const i1 = draggingEdgeIndex;
          const i2 = (draggingEdgeIndex + 1) % prev.length;
          next[i1] = { x: prev[i1].x + dMmX, y: prev[i1].y + dMmY };
          next[i2] = { x: prev[i2].x + dMmX, y: prev[i2].y + dMmY };
          return next;
        });
        lastMousePixelsRef.current = pixels;
      }
      if (canvas) canvas.style.cursor = 'grabbing';
    } else if (draggingOpeningId !== null) {
      const mm = screenToWorld(pixels);
      const op = openings.find(o => o.id === draggingOpeningId);
      if (op && op.wallIndex < pointsMm.length) {
        const wall = getWallSegment(pointsMm, op.wallIndex);
        if (!wall) return;
        const wallLength = wall.length;
        const l2 = wallLength * wallLength;
        
        if (l2 > 0) {
          let rawRatio = ((mm.x - wall.p1.x) * wall.dx + (mm.y - wall.p1.y) * wall.dy) / l2;
          const otherOps = openings
            .filter(o => o.wallIndex === op.wallIndex && o.id !== op.id)
            .map((other) => ({ ...other, width: getEffectiveOpeningWidthMm(other) }));
          const clampedRatio = clampOpeningRatioWithCollisions(
            rawRatio,
            wallLength,
            getEffectiveOpeningWidthMm(op),
            op.ratioPosition,
            otherOps
          );

          setOpenings(prev => prev.map(o => o.id === draggingOpeningId ? { ...o, ratioPosition: clampedRatio } : o));
        }
      }
      if (canvas) canvas.style.cursor = 'grabbing';
    } else if (canvas && (isSelectMode || isAddFurniture)) {
      const lh = lastFurnitureHoverCursorRef.current;
      const movedHover =
        lh === null || Math.hypot(pixels.x - lh.x, pixels.y - lh.y) >= 6;
      if (movedHover) {
        lastFurnitureHoverCursorRef.current = { x: pixels.x, y: pixels.y };
        const fh = resolveFurnitureHit(mm, pixels);
        if (!fh) {
          furnitureRingHoverRef.current = false;
        }
        if (fh) {
          const onBody = hitTestFurnitureItem(mm, fh);
          const onRing = hitTestFurnitureRotationRing(pixels, fh);
          furnitureRingHoverRef.current =
            !!activeFurnitureId && fh.id === activeFurnitureId && onRing && !onBody;
          if (activeFurnitureId === fh.id) {
            canvas.style.cursor = onRing || onBody ? 'grab' : 'auto';
          } else {
            canvas.style.cursor = onRing || onBody ? 'grab' : 'auto';
          }
        } else if (hitTestOpeningBody(mm) || hitTestPoint(pixels) !== -1 || hitTestEdge(pixels) !== null) {
          canvas.style.cursor = 'move';
        } else {
          canvas.style.cursor = 'auto';
        }
      }
    } else if (canvas) {
      lastFurnitureHoverCursorRef.current = null;
      furnitureRingHoverRef.current = false;
      canvas.style.cursor = 'auto';
    }
  };

  const handlePointerUp = () => {
    // ホバー予測マーカーは消す（キャンバス外へ出たとき／確定後に残らないように）。
    predictedWallPointRef.current = null;
    if (draggingUnderlayRef.current) {
      draggingUnderlayRef.current = false;
      underlayDragStartRef.current = null;
    }
    if (resizingUnderlayRef.current) {
      resizingUnderlayRef.current = false;
      underlayResizeStartRef.current = null;
    }
    if (beamDragRef.current) {
      beamDragRef.current = null;
    }
    const pv = furnitureInteractionPreviewRef.current;
    furnitureInteractionPreviewRef.current = null;
    if (pv?.kind === 'move') {
      const moveSet = new Set(useProjectStore.getState().selectedIds);
      onFurnitureUpdate((prev) => {
        const dragged = prev.find((f) => f.id === pv.id);
        if (!dragged) return prev;
        const nextPosition = mmToFurniturePosition(pv.centerMm, dragged.position[1], centerMm);
        const dx = nextPosition[0] - dragged.position[0];
        const dz = nextPosition[2] - dragged.position[2];
        // 複数選択（グループ含む）中は、選択メンバー全員を同じ差分で動かす（260623・Cフェーズ3）。
        const groupMove = moveSet.size > 1 && moveSet.has(pv.id);
        return prev.map((f) => {
          if (f.id === pv.id) return { ...f, position: nextPosition };
          if (groupMove && moveSet.has(f.id)) {
            return { ...f, position: [f.position[0] + dx, f.position[1], f.position[2] + dz] as [number, number, number] };
          }
          return f;
        });
      });
    } else if (pv?.kind === 'rotate') {
      onFurnitureUpdate((prev) =>
        prev.map((f) =>
          f.id === pv.id ? { ...f, rotation: [f.rotation[0], pv.yaw, f.rotation[2]] } : f
        )
      );
    }

    releasePointerCaptureSafe();
    setDraggingPointIndex(null);
    setDraggingEdgeIndex(null);
    setDraggingOpeningId(null);
    setDraggingFurnitureId(null);
    setRotatingFurnitureId(null);
    furnitureRotateDragStartRef.current = null;
    rotationWallOkRef.current = true;
    setIsPanning(false);
    lastMousePixelsRef.current = null;
    lastFurnitureHoverCursorRef.current = null;
    furnitureRingHoverRef.current = false;
    if (canvasRef.current) canvasRef.current.style.cursor = 'auto';
  };

  const handlePointerUpRef = useRef(handlePointerUp);
  handlePointerUpRef.current = handlePointerUp;

  useEffect(() => {
    const onWindowPointerEnd = () => handlePointerUpRef.current();
    window.addEventListener('pointerup', onWindowPointerEnd);
    window.addEventListener('pointercancel', onWindowPointerEnd);
    return () => {
      window.removeEventListener('pointerup', onWindowPointerEnd);
      window.removeEventListener('pointercancel', onWindowPointerEnd);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const applyPendingWheel = () => {
      wheelRafRef.current = null;
      const z = wheelPendingZoomRef.current;
      const o = wheelPendingOffsetRef.current;
      wheelPendingZoomRef.current = null;
      wheelPendingOffsetRef.current = null;
      if (z == null || o == null) return;
      viewZoomRef.current = z;
      viewOffsetRef.current = o;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomIntensity = 0.1;
      const rect = canvas.getBoundingClientRect();
      const pixels = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const curZ = wheelPendingZoomRef.current ?? viewZoomRef.current;
      const curOff = wheelPendingOffsetRef.current ?? viewOffsetRef.current;
      if (!Number.isFinite(curZ) || curZ <= 0) {
        viewZoomRef.current = DEFAULT_ZOOM;
        viewOffsetRef.current = { ...DEFAULT_OFFSET };
        wheelPendingZoomRef.current = null;
        wheelPendingOffsetRef.current = null;
        return;
      }
      const mmBefore = {
        x: (pixels.x - curOff.x) / curZ,
        y: (pixels.y - curOff.y) / curZ
      };
      if (!Number.isFinite(mmBefore.x) || !Number.isFinite(mmBefore.y)) {
        viewZoomRef.current = DEFAULT_ZOOM;
        viewOffsetRef.current = { ...DEFAULT_OFFSET };
        wheelPendingZoomRef.current = null;
        wheelPendingOffsetRef.current = null;
        return;
      }
      const newZoom = e.deltaY > 0 ? curZ * (1 - zoomIntensity) : curZ * (1 + zoomIntensity);
      const minZ = computeMinZoomForFloorplan(pointsMmRef.current, canvas.width, canvas.height);
      const clampedZoom = Math.max(minZ, Math.min(GLOBAL_ZOOM_MAX, newZoom));
      const nextOffset = {
        x: pixels.x - mmBefore.x * clampedZoom,
        y: pixels.y - mmBefore.y * clampedZoom
      };
      if (
        !Number.isFinite(clampedZoom) ||
        !Number.isFinite(nextOffset.x) ||
        !Number.isFinite(nextOffset.y)
      ) {
        return;
      }
      wheelPendingZoomRef.current = clampedZoom;
      wheelPendingOffsetRef.current = clampViewOffset(nextOffset);
      if (wheelRafRef.current == null) {
        wheelRafRef.current = requestAnimationFrame(applyPendingWheel);
      }
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      if (wheelRafRef.current != null) cancelAnimationFrame(wheelRafRef.current);
    };
  }, []);

  /** 辺の寸法（スクリーン軸の横表示）。多角形の外側へオフセット。roomCentroidMm は閉じた床の寸法ラベル用に1フレーム1回だけ渡す */
  const drawEdgeDimensionLabel = (
    ctx: CanvasRenderingContext2D,
    p1Mm: Point,
    p2Mm: Point,
    roomCentroidMm: Point | null
  ) => {
    if (viewZoomRef.current < MIN_ZOOM_FOR_SKETCH_LABELS) return;
    const mm = Math.round(Math.hypot(p2Mm.x - p1Mm.x, p2Mm.y - p1Mm.y));
    if (mm === 0) return;
    const p1 = worldToScreen(p1Mm);
    const p2 = worldToScreen(p2Mm);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const wlenMm = Math.hypot(p2Mm.x - p1Mm.x, p2Mm.y - p1Mm.y) || 1;
    const udx = (p2Mm.x - p1Mm.x) / wlenMm;
    const udy = (p2Mm.y - p1Mm.y) / wlenMm;
    let nnx = -udy;
    let nny = udx;
    const midMm = lerpPoint(p1Mm, p2Mm, 0.5);
    if (isClosed && pointsMm.length >= 3 && roomCentroidMm) {
      const c = roomCentroidMm;
      const toC = { x: c.x - midMm.x, y: c.y - midMm.y };
      if (nnx * toC.x + nny * toC.y < 0) {
        nnx = -nnx;
        nny = -nny;
      }
    }
    const pIn = worldToScreen({ x: midMm.x + nnx * 400, y: midMm.y + nny * 400 });
    const plen = Math.hypot(pIn.x - mid.x, pIn.y - mid.y) || 1;
    const inx = (pIn.x - mid.x) / plen;
    const iny = (pIn.y - mid.y) / plen;
    const dimScale = getArrowGizmoScale(viewZoomRef.current);
    const dimOut =
      (EDGE_DIM_OUTSET_EXTRA_BASE_PX + OPENING_ARROW_NORMAL_OFFSET_BASE_PX * 0.55 + WALL_EDGE_OUTSET_BASE_PX * 0.85) *
      dimScale;
    const labelPos = { x: mid.x - inx * dimOut, y: mid.y - iny * dimOut };
    ctx.save();
    ctx.font = '900 12px "Inter", sans-serif';
    const text = `${mm}mm`;
    const m = ctx.measureText(text);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(labelPos.x - m.width / 2 - 8, labelPos.y - 12, m.width + 16, 24);
    ctx.fillStyle = '#10b981';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, labelPos.x, labelPos.y);
    ctx.restore();
  };

  useEffect(() => {
    const render = () => {
      const frameStart = performance.now();
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (!canvas2dCtxRef.current) {
        canvas2dCtxRef.current = canvas.getContext('2d', { alpha: true });
      }
      const ctx = canvas2dCtxRef.current;
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const currentZoom = viewZoomRef.current;
      const currentOffset = viewOffsetRef.current;

      // 平面図/天伏図の「非アクティブ図面」をグレースケール＋半透明で描くためのフィルタ。
      // 天伏図のとき: 床レイヤ（壁・建具・床家具）を減衰。平面図のとき: 天井レイヤ（梁・天井家具）を減衰。
      // CSS filter の opacity は globalAlpha と独立に効くため、各描画ブロックの内部状態に干渉しにくい。
      const ceilingV = ceilingViewRef.current;
      const inactiveFilter = `grayscale(1) opacity(${inactiveOpacityRef.current})`;

      // 0. 下絵（背景画像）を最背面に描画
      const ul = underlayRef.current;
      const ulImg = underlayImgRef.current;
      if (ul && ul.visible && ulImg) {
        const mmPerPx = ul.scaleMmPerPx && ul.scaleMmPerPx > 0 ? ul.scaleMmPerPx : 10;
        const tl = worldToScreen({ x: ul.offsetX, y: ul.offsetY });
        const w = ulImg.width * mmPerPx * currentZoom;
        const h = ulImg.height * mmPerPx * currentZoom;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, ul.opacity));
        ctx.drawImage(ulImg, tl.x, tl.y, w, h);
        ctx.restore();
        // 移動モード時は枠と右下リサイズハンドルを表示（ドラッグで拡縮）。
        if (underlayMoveModeRef.current) {
          ctx.save();
          ctx.strokeStyle = 'rgba(16,185,129,0.9)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(tl.x, tl.y, w, h);
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(16,185,129,0.95)';
          ctx.fillRect(tl.x + w - 6, tl.y + h - 6, 12, 12);
          ctx.restore();
        }
      }

      // 1. Grid Lines
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      const visualGrid = gridSize > 50 ? gridSize : 500;
      const startX = Math.floor(((rulerSize - currentOffset.x) / currentZoom) / visualGrid) * visualGrid;
      const endX = Math.ceil(((canvasSize.width - currentOffset.x) / currentZoom) / visualGrid) * visualGrid;
      if (Number.isFinite(startX) && Number.isFinite(endX) && endX >= startX && Number.isFinite(visualGrid) && visualGrid > 0) {
        let gx = 0;
        for (let x = startX; x <= endX && gx < MAX_VIEW_GRID_ITER; x += visualGrid) {
          gx += 1;
          const px = x * currentZoom + currentOffset.x; if (px < rulerSize) continue;
          ctx.beginPath(); ctx.moveTo(px, rulerSize); ctx.lineTo(px, canvasSize.height); ctx.stroke();
        }
      }
      const startY = Math.floor(((rulerSize - currentOffset.y) / currentZoom) / visualGrid) * visualGrid;
      const endY = Math.ceil(((canvasSize.height - currentOffset.y) / currentZoom) / visualGrid) * visualGrid;
      if (Number.isFinite(startY) && Number.isFinite(endY) && endY >= startY && Number.isFinite(visualGrid) && visualGrid > 0) {
        let gy = 0;
        for (let y = startY; y <= endY && gy < MAX_VIEW_GRID_ITER; y += visualGrid) {
          gy += 1;
          const py = y * currentZoom + currentOffset.y; if (py < rulerSize) continue;
          ctx.beginPath(); ctx.moveTo(rulerSize, py); ctx.lineTo(canvasSize.width, py); ctx.stroke();
        }
      }
      ctx.restore();

      // スナップドットは描画しない（ズームアウト時の二重ループ負荷回避）。グリッドスナップは getSnappedMm 等で従来どおり有効。

      if (pointsMm.length > 0) {
        // 床レイヤ（壁・建具）: 天伏図では非アクティブのため減衰。
        if (ceilingV) ctx.filter = inactiveFilter;
        const gizmoScale = getArrowGizmoScale(currentZoom);
        const gizmoArm = GIZMO_ARM_BASE_PX * gizmoScale;
        const gizmoHead = GIZMO_HEAD_BASE_PX * gizmoScale;
        const gizmoStroke = GIZMO_STROKE_BASE_PX * gizmoScale;
        const gizmoOffset = GIZMO_OFFSET_BASE_PX * gizmoScale;
        const gizmoNormalOff = OPENING_ARROW_NORMAL_OFFSET_BASE_PX * gizmoScale;

        const screenPoints = pointsMm.map(p => ({
          x: p.x * currentZoom + currentOffset.x,
          y: p.y * currentZoom + currentOffset.y
        }));
        
        // Draw Fill
        if (isClosed) { 
            ctx.fillStyle = 'rgba(16, 185, 129, 0.08)'; 
            ctx.beginPath(); 
            ctx.moveTo(screenPoints[0].x, screenPoints[0].y); 
            screenPoints.forEach(p => ctx.lineTo(p.x, p.y)); 
            ctx.closePath(); 
            ctx.fill(); 
        }
        
        // Draw Lines
        ctx.lineWidth = 3;
        const edgeCount = isClosed ? pointsMm.length : pointsMm.length - 1;
        for (let i = 0; i < edgeCount; i++) {
            const p1 = screenPoints[i];
            const p2 = screenPoints[(i + 1) % screenPoints.length];
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            if (selectedEdgeIndex === i) {
                ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 5; ctx.stroke(); ctx.lineWidth = 3;
            } else {
                ctx.strokeStyle = isClosed ? '#10b981' : '#fff'; ctx.stroke();
            }
        }

        // Draw Labels（閉多角形の外側判定用に重心は1回だけ）
        const roomCentroidForLabels =
          isClosed && pointsMm.length >= 3 && currentZoom >= MIN_ZOOM_FOR_SKETCH_LABELS
            ? polygonCentroidMm(pointsMm)
            : null;
        pointsMm.forEach((p, i) => i > 0 && drawEdgeDimensionLabel(ctx, pointsMm[i - 1], p, roomCentroidForLabels));
        if (isClosed) drawEdgeDimensionLabel(ctx, pointsMm[pointsMm.length - 1], pointsMm[0], roomCentroidForLabels);

        // 壁辺選択: 端点に壁平行矢印、中点に法線矢印（寸法は外側）
        if (selectedEdgeIndex !== null) {
          const wall = getWallSegment(pointsMm, selectedEdgeIndex);
          if (wall) {
            const sp1 = worldToScreen(wall.p1);
            const sp2 = worldToScreen(wall.p2);
            const selElen = Math.hypot(sp2.x - sp1.x, sp2.y - sp1.y) || 1;
            const stx = (sp2.x - sp1.x) / selElen;
            const sty = (sp2.y - sp1.y) / selElen;
            const sang = Math.atan2(sty, stx);
            const midMm = lerpPoint(wall.p1, wall.p2, 0.5);
            const wlen = wall.length || 1;
            let nnx = -wall.dy / wlen;
            let nny = wall.dx / wlen;
            if (isClosed && pointsMm.length >= 3) {
              const c = polygonCentroidMm(pointsMm);
              if (c) {
                const toC = { x: c.x - midMm.x, y: c.y - midMm.y };
                if (nnx * toC.x + nny * toC.y < 0) {
                  nnx = -nnx;
                  nny = -nny;
                }
              }
            }
            const midS = { x: (sp1.x + sp2.x) / 2, y: (sp1.y + sp2.y) / 2 };
            const pIn = worldToScreen({ x: midMm.x + nnx * 400, y: midMm.y + nny * 400 });
            const pinLen = Math.hypot(pIn.x - midS.x, pIn.y - midS.y) || 1;
            const inx = (pIn.x - midS.x) / pinLen;
            const iny = (pIn.y - midS.y) / pinLen;
            const wallOut = WALL_EDGE_OUTSET_BASE_PX * gizmoScale;
            const outx = -inx;
            const outy = -iny;
            const perpCenter = {
              x: midS.x + inx * gizmoNormalOff + outx * wallOut,
              y: midS.y + iny * gizmoNormalOff + outy * wallOut
            };
            const ig = gizmoOffset;
            const ou = gizmoOffset + gizmoArm;
            const gh = gizmoHead;

            ctx.save();
            ctx.strokeStyle = '#ffffff';
            ctx.fillStyle = '#ffffff';
            ctx.lineWidth = gizmoStroke;

            ctx.save();
            ctx.translate(sp1.x, sp1.y);
            ctx.rotate(sang);
            ctx.beginPath();
            ctx.moveTo(-ou, 0);
            ctx.lineTo(-ig, 0);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-ou, 0);
            ctx.lineTo(-ou + gh, -gh * 0.7);
            ctx.lineTo(-ou + gh, gh * 0.7);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.translate(sp2.x, sp2.y);
            ctx.rotate(sang);
            ctx.beginPath();
            ctx.moveTo(ig, 0);
            ctx.lineTo(ou, 0);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(ou, 0);
            ctx.lineTo(ou - gh, -gh * 0.7);
            ctx.lineTo(ou - gh, gh * 0.7);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.translate(perpCenter.x, perpCenter.y);
            ctx.rotate(sang);
            ctx.beginPath();
            ctx.moveTo(0, -ig);
            ctx.lineTo(0, -ou);
            ctx.moveTo(0, ig);
            ctx.lineTo(0, ou);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, -ou);
            ctx.lineTo(-gh * 0.7, -ou + gh);
            ctx.lineTo(gh * 0.7, -ou + gh);
            ctx.closePath();
            ctx.moveTo(0, ou);
            ctx.lineTo(-gh * 0.7, ou - gh);
            ctx.lineTo(gh * 0.7, ou - gh);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            ctx.restore();
          }
        }

        // Draw Openings
        openings.forEach(op => {
          const wall = getWallSegment(pointsMm, op.wallIndex);
          if (!wall) return;
          const posMm = lerpPoint(wall.p1, wall.p2, op.ratioPosition);
          const pos = {
            x: posMm.x * currentZoom + currentOffset.x,
            y: posMm.y * currentZoom + currentOffset.y
          };
          const isSelected = selectedOpeningId === op.id;
          
          ctx.save();
          ctx.translate(pos.x, pos.y);
          const angle = getWallAngle2D(wall.p1, wall.p2);
          ctx.rotate(angle);
          
          ctx.fillStyle = op.type.startsWith('door') ? '#f97316' : '#0ea5e9';
          if (isSelected) ctx.fillStyle = '#fbbf24';

          const w = (op.width * currentZoom) / 2;
          ctx.fillRect(-w, -4, w * 2, 8);
          ctx.strokeStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.5)';
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.strokeRect(-w, -4, w * 2, 8);

          // Door Arc — 既定は室内側へ開く（部屋重心側＝描画方向に依存しない: 3c）。
          // op.swingFlipX(吊り元 左右) / op.swingFlipY(内外) で手動反転（3e）。
          if (op.type.startsWith('door')) {
            const c = pointsMm.length >= 3 ? polygonCentroidMm(pointsMm) : null;
            // 壁ローカル -y(現状の弧が向く側) が室内側か。dot((dy,-dx), 重心方向)>=0 で室内。
            const localMinusYInterior = c
              ? wall.dy * (c.x - posMm.x) - wall.dx * (c.y - posMm.y) >= 0
              : true;
            const sx = op.swingFlipX ? -1 : 1;
            const sy = (localMinusYInterior ? 1 : -1) * (op.swingFlipY ? -1 : 1);
            ctx.save();
            ctx.scale(sx, sy);
            ctx.beginPath();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = isSelected ? '#fbbf24' : '#f97316';
            // Draw arc representing door swing
            ctx.arc(-w, 0, w * 2, 0, -Math.PI / 2, true);
            ctx.stroke();
            ctx.setLineDash([]);
            // Draw door leaf
            ctx.beginPath();
            ctx.moveTo(-w, 0);
            ctx.lineTo(-w, -w * 2);
            ctx.stroke();
            ctx.restore();
          }
          if (isSelected) {
            // 窓/ドア: 壁平行の左右矢印
            const arrowLen = gizmoArm;
            const head = gizmoHead;
            const offset = Math.max(12 * gizmoScale, gizmoOffset + gizmoArm * 0.85);
            const normalOffset = gizmoNormalOff;
            ctx.strokeStyle = '#ffffff';
            ctx.fillStyle = '#ffffff';
            ctx.lineWidth = gizmoStroke;
            ctx.beginPath();
            ctx.moveTo(-offset, -normalOffset);
            ctx.lineTo(-offset - arrowLen, -normalOffset);
            ctx.moveTo(offset, -normalOffset);
            ctx.lineTo(offset + arrowLen, -normalOffset);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-offset - arrowLen, -normalOffset);
            ctx.lineTo(-offset - arrowLen + head, -normalOffset - head * 0.7);
            ctx.lineTo(-offset - arrowLen + head, -normalOffset + head * 0.7);
            ctx.closePath();
            ctx.moveTo(offset + arrowLen, -normalOffset);
            ctx.lineTo(offset + arrowLen - head, -normalOffset - head * 0.7);
            ctx.lineTo(offset + arrowLen - head, -normalOffset + head * 0.7);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        });
        ctx.filter = 'none';

        // Draw Furniture (2D footprint)
        furnitureItemsRef.current.forEach((item) => {
          // 床家具/天井家具を現在のビューに応じて減衰（天伏図では床家具、平面図では天井家具）。
          const _inactiveFurn = ceilingV ? !item.ceilingMount : !!item.ceilingMount;
          ctx.filter = _inactiveFurn ? inactiveFilter : 'none';
          const pose = getFurniturePoseMmForDraw(item);
          const { width, depth } = getFurnitureFootprintMm(item);
          const centerPx = worldToScreen(pose.center);
          if (!isSafeFurniture2DDraw(width, depth, centerPx)) return;
          const isSelected = activeFurnitureId === item.id;
          const isRotating = rotatingFurnitureId === item.id;
          if (currentZoom < MIN_ZOOM_FOR_FURNITURE_DOT_ONLY) {
            ctx.save();
            ctx.fillStyle = isSelected ? '#fbbf24' : 'rgba(196, 181, 253, 0.9)';
            ctx.beginPath();
            ctx.arc(centerPx.x, centerPx.y, isSelected ? 5 : 3.5, 0, Math.PI * 2);
            ctx.fill();
            if (isSelected) {
              ctx.strokeStyle = 'rgba(255,255,255,0.85)';
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }
            ctx.restore();
            return;
          }

          const halfW = (width * currentZoom) / 2;
          const halfD = (depth * currentZoom) / 2;
          const fullGizmo = currentZoom >= MIN_ZOOM_FOR_FURNITURE_FULL_GIZMO;
          const arrowLen = fullGizmo
            ? Math.max(18, halfW * 0.6)
            : Math.min(12, Math.max(5, halfW * 0.5));
          const arrowHead = fullGizmo ? Math.max(6, arrowLen * 0.32) : Math.max(3, arrowLen * 0.3);

          ctx.save();
          ctx.translate(centerPx.x, centerPx.y);
          ctx.rotate(yawToSketchRotation(pose.yaw));
          ctx.strokeStyle = isSelected ? '#fbbf24' : 'rgba(196, 181, 253, 0.95)';
          ctx.lineWidth = isSelected ? 2.2 : 1.4;
          if (fullGizmo || isSelected) {
            ctx.fillStyle = isSelected ? 'rgba(251, 191, 36, 0.24)' : 'rgba(139, 92, 246, 0.14)';
            ctx.fillRect(-halfW, -halfD, width * currentZoom, depth * currentZoom);
          }
          ctx.strokeRect(-halfW, -halfD, width * currentZoom, depth * currentZoom);

          const labelText = truncateFurnitureLabel(item.customName ?? item.name ?? '');
          if (labelText && currentZoom >= MIN_ZOOM_FOR_FURNITURE_LABELS) {
            const rectPxW = width * currentZoom;
            const rectPxH = depth * currentZoom;
            if (Math.min(rectPxW, rectPxH) < MIN_LABEL_RECT_PX) {
              ctx.restore();
              return;
            }
            const fontPx = Math.max(8, Math.min(14, Math.min(rectPxW, rectPxH) * 0.12));
            ctx.font = `${fontPx}px "Inter", system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const labelY = 0;
            const maxW = Math.min(rectPxW, rectPxH) * 0.92;
            const drawText = ctx.measureText(labelText).width <= maxW ? labelText : `${labelText.slice(0, 1)}…`;
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.strokeStyle = '#0f172a';
            ctx.lineWidth = Math.max(2, fontPx * 0.22);
            ctx.strokeText(drawText, 0, labelY);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(drawText, 0, labelY);
          }

          ctx.beginPath();
          ctx.moveTo(0, -halfD);
          ctx.lineTo(0, -halfD - arrowLen);
          ctx.moveTo(0, -halfD - arrowLen);
          ctx.lineTo(-arrowHead * 0.7, -halfD - arrowLen + arrowHead);
          ctx.moveTo(0, -halfD - arrowLen);
          ctx.lineTo(arrowHead * 0.7, -halfD - arrowLen + arrowHead);
          ctx.strokeStyle = isSelected ? '#f59e0b' : '#c4b5fd';
          ctx.lineWidth = isSelected ? 2 : 1.4;
          ctx.stroke();

          ctx.restore();

          if (isSelected) {
            const ringR = getFurnitureRotationRingRadiusPx(width, depth, currentZoom);
            const lw = fullGizmo ? gizmoStroke : Math.max(1, gizmoStroke * 0.85);
            const ringHi =
              furnitureRingHoverRef.current && !isRotating;
            const ringStroke = ringHi ? '#93c5fd' : '#2563eb';
            ctx.save();
            ctx.translate(centerPx.x, centerPx.y);
            if (isRotating) {
              drawFurnitureRotationRingIcon(ctx, ringR, {
                dashed: true,
                lineWidth: lw,
                strokeStyle: ringStroke,
                fillStyle: ringStroke,
                gizmoScale
              });
            } else {
              drawFurnitureRotationRingIcon(ctx, ringR, {
                lineWidth: lw,
                strokeStyle: ringStroke,
                fillStyle: ringStroke,
                gizmoScale
              });
            }
            ctx.restore();
          }
        });

        // 複数選択（selectedIds）のハイライト。primary(activeFurnitureId)は既存のギズモで示すため除外し、
        // それ以外の選択家具を緑の点線枠で囲う（260623・Cフェーズ2）。
        {
          const sel = selectedIdsRef.current;
          if (sel.length > 0) {
            const set = new Set(sel);
            ctx.save();
            ctx.filter = 'none';
            ctx.strokeStyle = 'rgba(52, 211, 153, 0.95)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            furnitureItemsRef.current.forEach((item) => {
              if (!set.has(item.id) || item.id === activeFurnitureId) return;
              const pose = getFurniturePoseMmForDraw(item);
              const { width, depth } = getFurnitureFootprintMm(item);
              const centerPx = worldToScreen(pose.center);
              if (!isSafeFurniture2DDraw(width, depth, centerPx)) return;
              const halfW = (width * currentZoom) / 2 + 3;
              const halfD = (depth * currentZoom) / 2 + 3;
              ctx.save();
              ctx.translate(centerPx.x, centerPx.y);
              ctx.rotate(yawToSketchRotation(pose.yaw));
              ctx.strokeRect(-halfW, -halfD, halfW * 2, halfD * 2);
              ctx.restore();
            });
            ctx.setLineDash([]);
            ctx.restore();
          }
        }

        // Draw Opening Preview (Hover & Snap)
        if (hoveredOpeningRef.current) {
          const { wallIndex, ratioPosition, type } = hoveredOpeningRef.current;
          const wall = getWallSegment(pointsMm, wallIndex);
          if (wall) {
            const posMm = lerpPoint(wall.p1, wall.p2, ratioPosition);
            const pos = {
              x: posMm.x * currentZoom + currentOffset.x,
              y: posMm.y * currentZoom + currentOffset.y
            };
            ctx.save();
            ctx.translate(pos.x, pos.y);
            ctx.rotate(getWallAngle2D(wall.p1, wall.p2));
            ctx.fillStyle = type.startsWith('door') ? 'rgba(249, 115, 22, 0.4)' : 'rgba(14, 165, 233, 0.4)';
            const w = ((type.startsWith('door') ? 900 : 1500) * currentZoom) / 2;
            ctx.fillRect(-w, -6, w * 2, 12);
            
            if (type.startsWith('door')) {
              // プレビューも配置後と同じ室内側へ開く向きで表示（3c）。
              const c = pointsMm.length >= 3 ? polygonCentroidMm(pointsMm) : null;
              const sy = c ? (wall.dy * (c.x - posMm.x) - wall.dx * (c.y - posMm.y) >= 0 ? 1 : -1) : 1;
              ctx.save();
              ctx.scale(1, sy);
              ctx.beginPath();
              ctx.setLineDash([3, 3]);
              ctx.strokeStyle = 'rgba(249, 115, 22, 0.4)';
              ctx.arc(-w, 0, w * 2, 0, -Math.PI / 2, true);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.moveTo(-w, 0);
              ctx.lineTo(-w, -w * 2);
              ctx.stroke();
              ctx.restore();
            }
            ctx.restore();
          }
        }
        
        // Draw Current Drawing Line
        if (isDrawing && !isClosed) {
          const lastMm = pointsMm[pointsMm.length - 1];
          const currentMm = {
            x: (mousePosRef.current.x - currentOffset.x) / currentZoom,
            y: (mousePosRef.current.y - currentOffset.y) / currentZoom
          };
          const snappedMm = getSnappedMm(currentMm, lastMm);
          const sPx = { x: snappedMm.x * currentZoom + currentOffset.x, y: snappedMm.y * currentZoom + currentOffset.y };
          const lPx = { x: lastMm.x * currentZoom + currentOffset.x, y: lastMm.y * currentZoom + currentOffset.y };
          
          ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; ctx.beginPath(); ctx.moveTo(lPx.x, lPx.y); ctx.lineTo(sPx.x, sPx.y); ctx.stroke(); ctx.setLineDash([]);
          drawEdgeDimensionLabel(ctx, lastMm, snappedMm, null);
          if (isAngleSnapEnabled && !isGridSnapEnabled) {
            const angle = Math.round(Math.atan2(snappedMm.y - lastMm.y, snappedMm.x - lastMm.x) * 180 / Math.PI);
            ctx.fillStyle = '#60a5fa'; ctx.font = 'bold 12px "Inter"'; ctx.fillText(`${angle}°`, sPx.x + 10, sPx.y - 10);
          }
        }

        // 予測位置（次の停止点）のハイライト。窓/ドアのプレビューと同様に半透明＋輪郭で「ここに置かれる」を明示する。
        // draw モードのホバー中のみ predictedWallPointRef が set される（確定前でも最初の点の位置を表示）。
        const predMm = predictedWallPointRef.current;
        if (predMm && !isClosed) {
          const ppx = predMm.x * currentZoom + currentOffset.x;
          const ppy = predMm.y * currentZoom + currentOffset.y;
          ctx.save();
          ctx.beginPath();
          ctx.arc(ppx, ppy, 9, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.95)';
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(ppx - 5, ppy); ctx.lineTo(ppx + 5, ppy);
          ctx.moveTo(ppx, ppy - 5); ctx.lineTo(ppx, ppy + 5);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        }

        // Draw Points
        screenPoints.forEach((p, i) => {
          const isSelected = selectedPointIndex === i;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (i === 0 && !isClosed) || draggingPointIndex === i || isSelected ? 7 : 4, 0, Math.PI * 2);
          if (isSelected) ctx.fillStyle = '#fbbf24';
          else if (i === 0) ctx.fillStyle = '#ef4444';
          else if (draggingPointIndex === i) ctx.fillStyle = '#60a5fa';
          else ctx.fillStyle = '#10b981';
          ctx.fill();
          if (isSelected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
          if (isSelected) {
            const innerGap = gizmoOffset;
            const outer = gizmoOffset + gizmoArm;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.beginPath();
            ctx.moveTo(innerGap, 0);
            ctx.lineTo(outer, 0);
            ctx.moveTo(-innerGap, 0);
            ctx.lineTo(-outer, 0);
            ctx.moveTo(0, innerGap);
            ctx.lineTo(0, outer);
            ctx.moveTo(0, -innerGap);
            ctx.lineTo(0, -outer);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = gizmoStroke;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(outer, 0); ctx.lineTo(outer - gizmoHead, -gizmoHead * 0.7); ctx.lineTo(outer - gizmoHead, gizmoHead * 0.7); ctx.closePath();
            ctx.moveTo(-outer, 0); ctx.lineTo(-outer + gizmoHead, -gizmoHead * 0.7); ctx.lineTo(-outer + gizmoHead, gizmoHead * 0.7); ctx.closePath();
            ctx.moveTo(0, outer); ctx.lineTo(-gizmoHead * 0.7, outer - gizmoHead); ctx.lineTo(gizmoHead * 0.7, outer - gizmoHead); ctx.closePath();
            ctx.moveTo(0, -outer); ctx.lineTo(-gizmoHead * 0.7, -outer + gizmoHead); ctx.lineTo(gizmoHead * 0.7, -outer + gizmoHead); ctx.closePath();
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.restore();
          }
        });
        ctx.filter = 'none';
      }

      // Draw Rulers (Internalized)
      ctx.save();
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, canvasSize.width, rulerSize);
      ctx.fillRect(0, 0, rulerSize, canvasSize.height);
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(rulerSize, 0); ctx.lineTo(rulerSize, canvasSize.height); ctx.moveTo(0, rulerSize); ctx.lineTo(canvasSize.width, rulerSize); ctx.stroke();
      ctx.fillStyle = '#666'; ctx.font = '10px "Inter", sans-serif'; ctx.textAlign = 'center';
      const step = currentZoom < 0.05 ? 10000 : currentZoom < 0.15 ? 5000 : 1000;
      const subStep = step / 5;
      const startMmX = Math.floor(((rulerSize - currentOffset.x) / currentZoom) / subStep) * subStep;
      const endMmX = Math.ceil(((canvasSize.width - currentOffset.x) / currentZoom) / subStep) * subStep;
      if (Number.isFinite(startMmX) && Number.isFinite(endMmX) && Number.isFinite(subStep) && subStep > 0 && endMmX >= startMmX) {
        let rx = 0;
        for (let xMm = startMmX; xMm <= endMmX && rx < MAX_VIEW_GRID_ITER; xMm += subStep) {
          rx += 1;
          const px = xMm * currentZoom + currentOffset.x;
          if (px < rulerSize) continue;
          const isMain = xMm % step === 0;
          ctx.strokeStyle = isMain ? '#333' : '#1a1a1a';
          ctx.beginPath(); ctx.moveTo(px, rulerSize - (isMain ? 10 : 5)); ctx.lineTo(px, rulerSize); ctx.stroke();
          if (isMain) ctx.fillText(xMm.toString(), px, rulerSize - 14);
        }
      }
      ctx.textAlign = 'right';
      const startMmY = Math.floor(((rulerSize - currentOffset.y) / currentZoom) / subStep) * subStep;
      const endMmY = Math.ceil(((canvasSize.height - currentOffset.y) / currentZoom) / subStep) * subStep;
      if (Number.isFinite(startMmY) && Number.isFinite(endMmY) && Number.isFinite(subStep) && subStep > 0 && endMmY >= startMmY) {
        let ry = 0;
        for (let yMm = startMmY; yMm <= endMmY && ry < MAX_VIEW_GRID_ITER; yMm += subStep) {
          ry += 1;
          const py = yMm * currentZoom + currentOffset.y;
          if (py < rulerSize) continue;
          const isMain = yMm % step === 0;
          ctx.strokeStyle = isMain ? '#333' : '#1a1a1a';
          ctx.beginPath(); ctx.moveTo(rulerSize - (isMain ? 10 : 5), py); ctx.lineTo(rulerSize, py); ctx.stroke();
          if (isMain) { ctx.save(); ctx.translate(rulerSize - 14, py); ctx.rotate(-Math.PI / 2); ctx.fillText(yMm.toString(), 0, 0); ctx.restore(); }
        }
      }
      ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, rulerSize, rulerSize);
      ctx.restore();

      // 梁（天井レイヤ）。平面図では非アクティブのため減衰し、天伏図では通常表示。
      // 壁梁(wallIndex)は現在の壁形状から幾何を導出し、室内側へ半透明の黄色バンドで描く（壁移動に追従）。
      // 自由梁は中心線の両側に半透明オレンジのバンドで描く。
      ctx.filter = ceilingV ? 'none' : inactiveFilter;
      const beamList = beamsRef.current;
      if (beamList.length > 0) {
        ctx.save();
        const beamCentroid = pointsMm.length >= 3 ? polygonCentroidMm(pointsMm) : null;
        // 2b: 壁梁を隣接マイター接合するため、壁梁が乗っているエッジ index → バンド幅(mm) を集める。
        const wallBeamWidths = new Map<number, number>();
        for (const bb of beamList) {
          if (bb.wallIndex !== undefined) wallBeamWidths.set(bb.wallIndex, bb.widthMm);
        }
        for (const beam of beamList) {
          let cx = beam.cx;
          let cy = beam.cy;
          let lengthMm = beam.lengthMm;
          let angleDeg = beam.angleDeg;
          const isWallBeam = beam.wallIndex !== undefined;
          if (isWallBeam) {
            const w = getWallSegment(pointsMm, beam.wallIndex as number);
            if (!w) continue; // 壁が削除された → 描画スキップ
            cx = (w.p1.x + w.p2.x) / 2;
            cy = (w.p1.y + w.p2.y) / 2;
            lengthMm = w.length;
            angleDeg = (Math.atan2(w.dy, w.dx) * 180) / Math.PI;
          }
          const rad = (angleDeg * Math.PI) / 180;
          const ux = Math.cos(rad);
          const uy = Math.sin(rad);
          const half = lengthMm / 2;
          const ax = cx - ux * half;
          const ay = cy - uy * half;
          const bx2 = cx + ux * half;
          const by2 = cy + uy * half;
          let px = -uy;
          let py = ux;
          let c1, c2, c3, c4;
          if (isWallBeam) {
            // 室内側（重心方向）へ widthMm のバンド。隣接壁梁とマイター接合し入隅の隙間/出角の重なりを解消（2b）。
            const mitered = pointsMm.length >= 3
              ? getWallBeamBandCornersMm(pointsMm, wallBeamWidths, beam.wallIndex as number)
              : null;
            if (mitered) {
              c1 = mitered.c1;
              c2 = mitered.c2;
              c3 = mitered.c3;
              c4 = mitered.c4;
            } else {
              // フォールバック: 従来の直角キャップ。
              if (beamCentroid && px * (beamCentroid.x - cx) + py * (beamCentroid.y - cy) < 0) {
                px = -px;
                py = -py;
              }
              c1 = { x: ax, y: ay };
              c2 = { x: bx2, y: by2 };
              c3 = { x: bx2 + px * beam.widthMm, y: by2 + py * beam.widthMm };
              c4 = { x: ax + px * beam.widthMm, y: ay + py * beam.widthMm };
            }
          } else {
            // 自由梁: 両端を壁線に沿って切る（壁⇔壁を張る梁の端面を壁と面一にし、斜め壁での突き出し/隙間を解消）。
            const mitered = isClosedRef.current
              ? freeBeamWallMiterCornersMm(pointsMm, true, cx, cy, angleDeg, beam.widthMm)
              : null;
            if (mitered) {
              c1 = mitered.c1;
              c2 = mitered.c2;
              c3 = mitered.c3;
              c4 = mitered.c4;
            } else {
              // 壁に張らない/開いた図形ではフォールバックで従来の矩形（直角キャップ）。
              const wh = beam.widthMm / 2;
              c1 = { x: ax + px * wh, y: ay + py * wh };
              c2 = { x: bx2 + px * wh, y: by2 + py * wh };
              c3 = { x: bx2 - px * wh, y: by2 - py * wh };
              c4 = { x: ax - px * wh, y: ay - py * wh };
            }
          }
          const s1 = worldToScreen(c1);
          const s2 = worldToScreen(c2);
          const s3 = worldToScreen(c3);
          const s4 = worldToScreen(c4);
          const selected = beam.id === selectedBeamIdRef.current;
          ctx.beginPath();
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.lineTo(s3.x, s3.y);
          ctx.lineTo(s4.x, s4.y);
          ctx.closePath();
          if (isWallBeam) {
            ctx.fillStyle = selected ? 'rgba(250,204,21,0.55)' : 'rgba(250,204,21,0.30)';
            ctx.strokeStyle = selected ? 'rgba(250,204,21,0.95)' : 'rgba(250,204,21,0.7)';
          } else {
            ctx.fillStyle = selected ? 'rgba(249,115,22,0.5)' : 'rgba(249,115,22,0.28)';
            ctx.strokeStyle = selected ? 'rgba(249,115,22,0.95)' : 'rgba(249,115,22,0.7)';
          }
          ctx.fill();
          ctx.lineWidth = selected ? 2 : 1;
          ctx.stroke();

          // 選択中の自由梁: 回転ハンドル（天伏図のみ）。ドラッグで角度変更、本体ドラッグで移動。
          if (ceilingV && selected && !isWallBeam) {
            const endP = worldToScreen({ x: cx + (lengthMm / 2) * ux, y: cy + (lengthMm / 2) * uy });
            const handP = worldToScreen({ x: cx + (lengthMm / 2 + 600) * ux, y: cy + (lengthMm / 2 + 600) * uy });
            ctx.beginPath();
            ctx.moveTo(endP.x, endP.y);
            ctx.lineTo(handP.x, handP.y);
            ctx.strokeStyle = 'rgba(249,115,22,0.9)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(handP.x, handP.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(249,115,22,0.95)';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        ctx.restore();
      }
      ctx.filter = 'none';

      const frameMs = performance.now() - frameStart;
      if (PERF_TRACE && frameMs > PERF_FRAME_WARN_MS && furnitureItemsRef.current.length > 0) {
        console.warn('[perf][2d-frame] slow frame', {
          frameMs: Math.round(frameMs),
          furnitureCount: furnitureItemsRef.current.length,
          zoom: Number(viewZoomRef.current.toFixed(4))
        });
      }
      requestRef.current = requestAnimationFrame(render);
    };

    requestRef.current = requestAnimationFrame(render);
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, [pointsMm, isDrawing, isClosed, gridSize, lengthSnapSize, isLengthSnapEnabled, angleSnap, isAngleSnapEnabled, draggingPointIndex, selectedPointIndex, selectedEdgeIndex, openings, selectedOpeningId, isGridSnapEnabled, activeFurnitureId, rotatingFurnitureId]);

  // 元に戻す/やり直し（260623: 上部フローティングバーから作図ツールバーへ統合）。Ctrl+Z/Y と同じ temporal を駆動。
  const canUndo = useStore(useProjectStore.temporal, (t) => t.pastStates.length > 0);
  const canRedo = useStore(useProjectStore.temporal, (t) => t.futureStates.length > 0);

  const getDeleteLabel = () => {
    if (activeFurnitureId) return '選択した家具を削除';
    if (selectedPointIndex !== null) return '選択した点を削除';
    if (selectedEdgeIndex !== null) return '選択した辺を削除';
    return '一つ戻る';
  };

  return (
    <div className="relative h-full w-full group pt-32 pb-6 pr-6 pl-6 lg:pl-[352px]" ref={containerRef}>

      {/* 左サイドツールパネル（平面/天伏 + 下絵 + 梁）。lg未満はドロワー（既定で隠し、左端タブで開閉）→ 狭幅でキャンバスを潰さない。 */}
      {/* 狭幅: ドロワーを開くタブ（閉じている間だけ表示） */}
      {!panelOpen && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="lg:hidden absolute left-0 top-1/2 z-[55] -translate-y-1/2 flex items-center gap-1.5 rounded-r-2xl border border-l-0 border-white/15 bg-[#0d0d0d]/95 py-3 pl-2 pr-3 text-[11px] font-black tracking-widest text-emerald-200 shadow-2xl backdrop-blur-md tap focus-ring"
          aria-label="作図ツールを開く"
        >
          <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" /></svg>
          ツール
        </button>
      )}
      {/* 狭幅: ドロワー背景（タップで閉じる） */}
      {panelOpen && (
        <div className="lg:hidden absolute inset-0 z-[54] bg-black/60" onClick={() => setPanelOpen(false)} aria-hidden />
      )}
      <div
        className={`absolute top-28 left-6 z-[55] lg:z-40 flex w-[320px] max-w-[86vw] flex-col gap-2 max-h-[calc(100vh-9rem)] overflow-y-auto scroll-dark pr-1 transition-transform duration-300 lg:translate-x-0 ${
          panelOpen ? 'translate-x-0' : '-translate-x-[150%] lg:translate-x-0'
        }`}
      >
      {/* 平面図 / 天伏図 切替（独立・最上段）(3b) */}
      <div className="glass rounded-2xl border border-white/10 bg-[#111]/80 p-1.5 text-[11px] text-neutral-200 shadow-xl backdrop-blur-xl">
        <div className="flex items-center gap-0.5 rounded-lg bg-black/40 p-0.5">
          <button
            type="button"
            onClick={() => {
              onCeilingViewChange?.(false);
              if (isBeamMode) setToolMode('select');
            }}
            className={`flex-1 rounded-md px-3 py-1 font-bold transition ${!isCeilingView ? 'bg-emerald-500 text-black' : 'text-neutral-400 hover:text-white'}`}
            title="平面図: 床面（壁・建具・床家具）を表示"
          >
            平面図
          </button>
          <button
            type="button"
            onClick={() => {
              onCeilingViewChange?.(true);
              if (isDrawMode || isAddWindow || isAddDoor) setToolMode('select');
            }}
            className={`flex-1 rounded-md px-3 py-1 font-bold transition ${isCeilingView ? 'bg-amber-500 text-black' : 'text-neutral-400 hover:text-white'}`}
            title="天伏図: 天井面（梁・天井オブジェクト）を表示。床面は半透明化。"
          >
            天伏図
          </button>
        </div>
      </div>

      {/* スナップ設定（旧・上部ツールバーから移設。lg以上は左カラム常時表示／狭幅はドロワー内。下絵スナップは下絵カード側）。 */}
      <div className="glass rounded-2xl border border-white/10 bg-[#111]/80 p-2.5 text-[11px] text-neutral-200 shadow-xl backdrop-blur-xl flex flex-col gap-2">
        <p className="text-[9px] font-black uppercase tracking-wider text-neutral-500">スナップ</p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold text-neutral-400">長さ(mm)</span>
          <div className="flex items-center gap-2 shrink-0">
            <NumericField value={lengthSnapSize} onChange={onLengthSnapSizeChange} dragSensitivity={5} className="h-8 w-[72px]" inputClassName="h-8 py-0 text-center text-emerald-400 focus-visible:ring-emerald-500/50" />
            <ToggleSwitch enabled={isLengthSnapEnabled ?? true} onChange={() => onLengthSnapToggle(!isLengthSnapEnabled)} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold text-neutral-400">角度</span>
          <div className="flex items-center gap-2 shrink-0">
            <NumericField value={angleSnap} onChange={onAngleSnapChange} dragSensitivity={0.5} className="h-8 w-[58px]" inputClassName="h-8 py-0 text-center text-emerald-400 focus-visible:ring-emerald-500/50" />
            <ToggleSwitch enabled={isAngleSnapEnabled ?? true} onChange={() => onAngleSnapToggle(!isAngleSnapEnabled)} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold text-neutral-400">グリッド</span>
          <div className="flex items-center gap-2 shrink-0">
            <select value={gridSize} onChange={(e) => onGridSizeChange(Number(e.target.value))} className="bg-[#000]/30 border border-white/10 rounded-lg pl-2 pr-1 h-8 text-xs font-mono text-emerald-400 focus:outline-none cursor-pointer hover:bg-white/5 transition-all">
              <option value="500">500mm</option>
              <option value="1000">1m</option>
              <option value="10000">10m</option>
            </select>
            <ToggleSwitch enabled={isGridSnapEnabled} onChange={() => setIsGridSnapEnabled(!isGridSnapEnabled)} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold text-neutral-400" title="ON で、新しい点を既存の頂点や、既存頂点と同じX/Y位置（整列）に自動で吸着させます">頂点スナップ</span>
          <ToggleSwitch enabled={isVertexSnapEnabled} onChange={() => setIsVertexSnapEnabled(!isVertexSnapEnabled)} />
        </div>
      </div>
      <div className="glass rounded-2xl border border-white/10 bg-[#111]/80 p-2 text-[11px] text-neutral-200 shadow-xl backdrop-blur-xl">
        {!underlay ? (
          <button
            type="button"
            onClick={() => underlayFileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg font-bold transition hover:bg-white/10"
          >
            下絵を挿入
          </button>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => underlayFileInputRef.current?.click()}
                className="font-bold transition hover:text-white"
                title="画像/PDFを差し替え"
              >
                下絵
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={underlay.opacity}
                onChange={(e) => onUnderlayChange?.({ ...underlay, opacity: Number(e.target.value) })}
                className="w-20"
                title="不透明度"
              />
              <button
                type="button"
                onClick={() => onUnderlayChange?.({ ...underlay, visible: !underlay.visible })}
                className="px-2 py-1 rounded transition hover:bg-white/10"
              >
                {underlay.visible ? '表示' : '非表示'}
              </button>
              <button
                type="button"
                onClick={() => setUnderlayMoveMode((v) => !v)}
                disabled={!underlay.visible}
                className={`px-2 py-1 rounded transition disabled:opacity-40 ${
                  underlayMoveMode ? 'bg-emerald-500 text-black' : 'hover:bg-white/10'
                }`}
                title="オンにして下絵をドラッグで移動、右下角のハンドルをドラッグでサイズ変更"
              >
                移動/拡縮
              </button>
              <button
                type="button"
                onClick={() => {
                  setUnderlayMoveMode(false);
                  onUnderlayChange?.(null);
                }}
                className="px-2 py-1 rounded text-red-300 transition hover:bg-red-500/20"
                title="下絵を削除"
              >
                ×
              </button>
            </div>
            {/* キャリブレーション: 実寸幅(mm) と 位置(mm) */}
            <div className="flex items-center gap-2 text-[10px] text-neutral-300">
              <label className="flex items-center gap-1">
                幅
                <input
                  type="number"
                  value={underlayImgSize ? Math.round(underlayImgSize.w * (underlay.scaleMmPerPx ?? 10)) : 0}
                  onChange={(e) => {
                    const widthMm = Number(e.target.value);
                    if (underlayImgSize && underlayImgSize.w > 0 && widthMm > 0) {
                      onUnderlayChange?.({ ...underlay, scaleMmPerPx: widthMm / underlayImgSize.w });
                    }
                  }}
                  className="w-16 rounded bg-black/40 px-1 py-0.5 text-right"
                />
                mm
              </label>
              <label className="flex items-center gap-1">
                X
                <input
                  type="number"
                  value={Math.round(underlay.offsetX)}
                  onChange={(e) => onUnderlayChange?.({ ...underlay, offsetX: Number(e.target.value) })}
                  className="w-14 rounded bg-black/40 px-1 py-0.5 text-right"
                />
              </label>
              <label className="flex items-center gap-1">
                Y
                <input
                  type="number"
                  value={Math.round(underlay.offsetY)}
                  onChange={(e) => onUnderlayChange?.({ ...underlay, offsetY: Number(e.target.value) })}
                  className="w-14 rounded bg-black/40 px-1 py-0.5 text-right"
                />
              </label>
            </div>
            {/* 下絵スナップ ON/OFF（壁の頂点を下絵の枠・辺・中心へ吸着）＋ サイズ変更のヒント */}
            <div className="flex items-center gap-2 text-[10px] text-neutral-400">
              <button
                type="button"
                onClick={() => setIsUnderlaySnapEnabled((v) => !v)}
                disabled={!underlay.visible}
                className={`px-2 py-0.5 rounded border transition disabled:opacity-40 ${
                  isUnderlaySnapEnabled
                    ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                    : 'border-white/15 text-neutral-300 hover:bg-white/10'
                }`}
                title="壁の頂点を下絵の枠・辺・中心へ吸着する"
              >
                下絵スナップ {isUnderlaySnapEnabled ? 'ON' : 'OFF'}
              </button>
              <span className="text-neutral-500">「移動/拡縮」ON中は角ドラッグで拡縮</span>
            </div>
          </div>
        )}
        <input
          ref={underlayFileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf"
          className="hidden"
          onChange={handleUnderlayFile}
        />
      </div>

      {/* 梁 */}
      <div className="glass rounded-2xl border border-white/10 bg-[#111]/80 p-2 text-[11px] text-neutral-200 shadow-xl backdrop-blur-xl">
        {beams.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">梁 {beams.length}本</span>
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-neutral-400">
          <span title="非アクティブな図面（平面/天伏）の表示濃度">非アクティブ濃度</span>
          <input
            type="range"
            min={0}
            max={0.8}
            step={0.05}
            value={inactiveLayerOpacity}
            onChange={(e) => setInactiveLayerOpacity(Number(e.target.value))}
            className="w-24"
          />
        </div>
        {beams.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {beams.map((b, i) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedBeamId(b.id)}
                className={`px-2 py-0.5 rounded text-[10px] transition ${
                  selectedBeamId === b.id
                    ? 'bg-amber-500/30 text-amber-200'
                    : 'bg-neutral-700/50 hover:bg-neutral-700'
                }`}
              >
                梁{i + 1}
              </button>
            ))}
          </div>
        )}
        {(() => {
          const b = beams.find((x) => x.id === selectedBeamId);
          if (!b) return null;
          const isWall = b.wallIndex !== undefined;
          return (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span
                className={`rounded px-1.5 py-0.5 ${isWall ? 'bg-yellow-500/20 text-yellow-200' : 'bg-orange-500/20 text-orange-200'}`}
                title={isWall ? '壁に乗る梁（長さ・角度・位置は壁に追従）' : '自由配置の梁'}
              >
                {isWall ? '壁梁' : '自由梁'}
              </span>
              <label className="flex items-center gap-1">
                長さ
                <NumericField
                  value={Math.round(b.lengthMm)}
                  onChange={(n) => updateBeam(b.id, { lengthMm: n })}
                  dragSensitivity={5}
                  disabled={isWall}
                  className="w-16"
                />
                mm
              </label>
              <label className="flex items-center gap-1">
                角度
                <NumericField
                  value={Math.round(b.angleDeg)}
                  onChange={(n) => updateBeam(b.id, { angleDeg: n })}
                  dragSensitivity={1}
                  disabled={isWall}
                  className="w-12"
                />
                °
              </label>
              <label className="flex items-center gap-1">
                幅
                <NumericField
                  value={Math.round(b.widthMm)}
                  onChange={(n) => updateBeam(b.id, { widthMm: Math.max(10, n) })}
                  dragSensitivity={2}
                  className="w-14"
                />
                mm
              </label>
              <label className="flex items-center gap-1">
                高さ
                <NumericField
                  value={Math.round(b.heightMm)}
                  onChange={(n) => updateBeam(b.id, { heightMm: Math.max(10, n) })}
                  dragSensitivity={2}
                  className="w-14"
                />
                mm
              </label>
              <label className="flex items-center gap-1">
                天井面からの距離
                <NumericField
                  value={Math.round(b.dropMm)}
                  onChange={(n) => updateBeam(b.id, { dropMm: Math.max(0, n) })}
                  dragSensitivity={2}
                  className="w-14"
                />
                mm
              </label>
              <label className="flex items-center gap-1">
                X
                <NumericField
                  value={Math.round(b.cx)}
                  onChange={(n) => updateBeam(b.id, { cx: n })}
                  dragSensitivity={5}
                  disabled={isWall}
                  className="w-14"
                />
              </label>
              <label className="flex items-center gap-1">
                Y
                <NumericField
                  value={Math.round(b.cy)}
                  onChange={(n) => updateBeam(b.id, { cy: n })}
                  dragSensitivity={5}
                  disabled={isWall}
                  className="w-14"
                />
              </label>
              <button
                type="button"
                onClick={() => removeBeam(b.id)}
                className="px-2 py-0.5 rounded text-red-300 transition hover:bg-red-500/20"
              >
                削除
              </button>
            </div>
          );
        })()}
      </div>
      </div>

      {/* Floating Toolbar (Right) — 全幅で右中央。スナップ設定を左パネルへ移したので上部ツールバーは低くなり干渉しない。 */}
      <div className="absolute top-1/2 -translate-y-1/2 right-4 flex flex-col gap-3 z-50 animate-in slide-in-from-right duration-700">
        <button onClick={() => handleZoomButton('in')} className="w-14 h-14 glass rounded-2xl flex items-center justify-center text-white hover:bg-white/10 transition-all shadow-xl font-bold text-xl">+</button>
        <button onClick={() => handleZoomButton('out')} className="w-14 h-14 glass rounded-2xl flex items-center justify-center text-white hover:bg-white/10 transition-all shadow-xl font-bold text-xl">-</button>
        <button onClick={handleFitToScreen} className="w-14 h-14 glass rounded-2xl flex items-center justify-center text-xs font-black text-neutral-400 hover:bg-white/10 transition-all uppercase tracking-tighter">全体</button>
      </div>

      {/* Floating Toolbar (Top Right) - Unified Controls */}
      {/* レスポンシブ（管理表 row 13）: md以上は最上段（top-6, モード切替の右隣の空きを活用）に上げ、
          Undo/Redo・ホームはこのツールバーの直下へ退避（上の useEffect が下端をストアへ通知）。
          md未満は折り返しで背が高くなるため top-[136px]（チップの下）に退避して重なり防止。
          最大幅は: md以上=モード切替(約20rem)を、lg以上=左固定パネル(24rem)を避ける。 */}
      {/* ※ slide-in 系のエントリーアニメ（translateY transform）は付けない:
          getBoundingClientRect は transform を含むため、アニメ途中の歪んだ値を計測してしまい、
          下端通知（Undo/Redo・ホームの退避位置）がズレる。アニメ無し＝確定レイアウトを即時計測。 */}
      <div
        ref={toolbarRef}
        className="absolute top-[136px] right-3 z-50 max-w-[calc(100vw_-_7rem)] md:top-6 md:max-w-[calc(100vw_-_20rem)] lg:right-6 lg:max-w-[calc(100vw_-_24rem)] pointer-events-auto"
      >
          <div className="relative glass p-2 lg:p-3 rounded-[24px] border border-white/10 flex flex-wrap items-center justify-end gap-2 lg:gap-3 2xl:gap-6 shadow-2xl backdrop-blur-xl bg-[#111]/80">
              
              {/* Tool mode: 選択・壁・窓・ドア（横並び。狭幅では折り返す） */}
              <div className="flex flex-wrap items-center gap-1 bg-black/40 p-1 rounded-xl border border-white/5">
                <button
                  type="button"
                  onClick={() => setToolMode('select')}
                  className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isSelectMode ? 'bg-white text-black' : 'text-neutral-400 hover:text-white'}`}
                >
                  選択
                </button>
                {/* 天伏図では壁・窓・ドアツールを隠す（3k）。選択と梁のみ。 */}
                {!isCeilingView && (
                  <>
                    <button
                      type="button"
                      onClick={() => setToolMode('draw')}
                      className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isDrawMode ? 'bg-emerald-500 text-black' : 'text-neutral-400 hover:text-white'}`}
                    >
                      壁
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setToolMode('add');
                        setAddKind('window');
                      }}
                      className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isAddWindow ? 'bg-sky-500 text-black' : 'text-neutral-400 hover:text-white'}`}
                    >
                      窓
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setToolMode('add');
                        setAddKind('door');
                      }}
                      className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isAddDoor ? 'bg-orange-500 text-black' : 'text-neutral-400 hover:text-white'}`}
                    >
                      ドア
                    </button>
                  </>
                )}
                {isCeilingView && (
                  <button
                    type="button"
                    onClick={() => setToolMode('beam')}
                    className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isBeamMode ? 'bg-yellow-500 text-black' : 'text-neutral-400 hover:text-white'}`}
                    title="梁: 壁をクリックで壁梁（壁に追従）、空きスペースで自由梁を配置"
                  >
                    梁
                  </button>
                )}
              </div>
              <div className="w-px h-8 bg-white/10" />

              {/* Editing Controls（狭幅では折り返す） */}
              <div className="flex flex-wrap items-center gap-2">
                  <button
                      type="button"
                      onClick={() => useProjectStore.temporal.getState().undo()}
                      disabled={!canUndo}
                      title="元に戻す (Ctrl+Z)"
                      className="h-11 px-4 rounded-xl text-xs font-black uppercase tracking-wider transition-all border border-white/5 bg-white/5 text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/5 flex items-center gap-1.5"
                  >
                      <Undo2 className="h-4 w-4" /> 一つ戻る
                  </button>
                  <button
                      type="button"
                      onClick={() => useProjectStore.temporal.getState().redo()}
                      disabled={!canRedo}
                      title="やり直す (Ctrl+Y)"
                      className="h-11 px-4 rounded-xl text-xs font-black uppercase tracking-wider transition-all border border-white/5 bg-white/5 text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/5 flex items-center gap-1.5"
                  >
                      <Redo2 className="h-4 w-4" /> やり直し
                  </button>
                  {(activeFurnitureId || selectedPointIndex !== null || selectedEdgeIndex !== null) && (
                    <button
                        type="button"
                        onClick={handleDeleteSelected}
                        className="h-11 px-4 rounded-xl text-xs font-black uppercase tracking-wider transition-all border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 flex items-center justify-center"
                    >
                        {getDeleteLabel()}
                    </button>
                  )}
                  
                  <button
                      onClick={async () => {
                        if (!(await confirm({ message: '壁・窓・ドア・家具・梁をすべて削除します。よろしいですか？', confirmLabel: '全消去', danger: true }))) return;
                        // ローカル（描画中の壁・選択）
                        setPointsMm([]); setIsClosed(false); setIsDrawing(false);
                        setSelectedPointIndex(null); setSelectedEdgeIndex(null); setSelectedBeamId(null);
                        // App 保有のコレクション（建具・家具・梁）と選択をクリア
                        setOpenings([]); onFurnitureUpdate([]); onBeamsChange?.([]);
                        onFurnitureSelect(null); onOpeningSelect(null);
                        // 確定済みの壁(sketchPoints)と素材割当も App 側で消す
                        onClearAll?.();
                      }}
                      className="h-11 px-6 rounded-xl text-xs text-red-400/80 hover:text-red-400 hover:bg-red-500/10 font-black uppercase tracking-wider transition-all border border-red-500/10"
                  >
                      全消去
                  </button>
              </div>

              <div className="w-px h-8 bg-white/10" />

              {/* Generate Button */}
              <button 
                  onClick={() => onApply(pointsMm.map(p => ({ x: mmToScaled(p.x), y: mmToScaled(p.y) })))} 
                  disabled={!isClosed} 
                  className={`h-11 px-8 rounded-xl font-black text-xs transition-all uppercase italic tracking-wider flex items-center gap-3
                  ${isClosed 
                      ? 'bg-emerald-500 text-black shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:scale-105 hover:bg-emerald-400' 
                      : 'bg-white/5 text-white/10 cursor-not-allowed border border-white/5'
                  }`}
              >
                  <span>3Dモデルを生成</span>
                  {isClosed && <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>}
              </button>

          </div>
      </div>

      <div className="relative pointer-events-auto h-full w-full" ref={canvasBoxRef}>
        {furnitureHint && (
          <div className="absolute bottom-6 left-1/2 z-[60] -translate-x-1/2 pointer-events-none px-5 py-2.5 rounded-2xl border border-amber-500/40 bg-black/85 text-amber-100 text-xs font-bold shadow-xl max-w-[90%] text-center">
            {furnitureHint}
          </div>
        )}
        <div className="absolute inset-0 bg-emerald-500/5 blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-1000"></div>
        <canvas
          ref={canvasRef} width={canvasSize.width} height={canvasSize.height}
          data-arise-sketch="1"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerUp}
          onContextMenu={(e) => e.preventDefault()}
          style={{ touchAction: 'none' }}
          className="bg-[#0b0b0b] rounded-[40px] border border-white/10 shadow-[0_0_80px_rgba(0,0,0,0.5)] block relative z-10"
        />
        {!isDrawing && pointsMm.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
            <div className="glass px-12 py-6 rounded-full border border-white/5 animate-pulse">
              <p className="text-neutral-500 text-xs font-black uppercase tracking-[0.4em] italic">キャンバスをクリックして図面作成を開始してください</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};