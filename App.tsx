import React, { useState, useRef, useMemo, useEffect, useCallback, Suspense, startTransition, memo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { useGLTF, Environment } from '@react-three/drei';
import { Wand2, Sparkles, LayoutGrid, LayoutList, ArrowUpDown, Trash2, Download } from 'lucide-react';
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js';
import { MaterialCategory, Product, RenderState, FurnitureItem, FurnitureCatalogItem, Opening, ToolMode, AddKind, CameraPreset, CameraBlendRequest, AiEstimateItem } from './types.js';
import { NumericField } from './components/NumericField.js';
import { RoomViewer } from './components/RoomViewer.js';
import { CameraPresetBar } from './components/CameraPresetBar.js';
import { WalkMovePad } from './components/WalkMovePad.js';
import { SketchCanvas } from './components/SketchCanvas.js';
import { FurnitureAssetStrip, type FurnitureCatalogFetchStatus } from './components/FurnitureAssetStrip.js';
import { FURNITURE_DIMS } from './constants.js';
import { getRoomTransform, scaledToMm, clampAllFurnitureToRoom, getEffectiveOpeningWidthMm } from './utils/sketchTransform.js';
import { lookDirection } from './utils/walkthrough.js';
import { computeGltfFootprintBaseMm } from './utils/furnitureModelFootprint.js';
import type { CostBreakdownEntry } from './utils/estimateExport.js';
import { buildEstimateExportPayload, downloadEstimateCsv } from './utils/estimateExport.js';
import { downloadEstimatePdf } from './utils/estimatePdf.js';
import { openingHoleAreaM2OnWallSegment } from './utils/openingArea.js';
import { getThumbnailImageUrlFromGlbUrl, getThumbnailPublicIdFromGlbUrl } from './utils/furnitureThumbnailUrl.js';
import * as THREE from 'three';

import { useAiRenderer } from './hooks/useAiRenderer.js';
import { useAiEditSession } from './hooks/useAiEditSession.js';
import { AiEditWorkspace } from './components/AiEditWorkspace.js';
import { ModeToggleBar } from './components/ModeToggleBar.js';
import { useProjectStore } from './lib/store/projectStore.js';
import { useEditorShortcuts } from './hooks/useEditorShortcuts.js';
import type { MaterialSettingsValue } from './lib/project/projectState.js';

const CAMERA_PRESETS_STORAGE_KEY = 'archviz-camera-presets-v1';
const MAX_CAMERA_PRESETS = 12;

type CameraMode = 'orbit' | 'walk';

type ViewMode = 'sketch' | '3D';
type SortOrder = 'price-asc' | 'price-desc' | 'name-asc' | 'default';
type OutsideBackgroundPreset = 'day' | 'evening' | 'night';

/** 表示スライダー位置 1–4 → catalogGridSize（1=リスト、その右へタイル小→大） */
const CATALOG_SLIDER_TO_GRID: Record<number, number> = { 1: 4, 2: 1, 3: 2, 4: 3 };
const CATALOG_GRID_TO_SLIDER: Record<number, number> = { 4: 1, 1: 2, 2: 3, 3: 4 };

const CATALOG_SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: 'default', label: '標準' },
  { value: 'price-asc', label: '価格: 安い順' },
  { value: 'price-desc', label: '価格: 高い順' },
  { value: 'name-asc', label: '名前: A-Z' },
];

interface SketchPoint {
  x: number;
  y: number;
}

interface ExtendedRenderState extends RenderState {
  debugBaseUrl?: string | null;
  debugMaskUrl?: string | null;
}

const degToRad = (deg: number) => (deg * Math.PI) / 180;
const DEFAULT_FOOTPRINT_2D_MM = { widthMm: 1000, depthMm: 700 };
type FurnitureModelMetadataEntry = {
  widthMm?: number;
  depthMm?: number;
  forwardYawDeg?: number;
};
type FurnitureModelMetadataMap = Record<string, FurnitureModelMetadataEntry>;

const normalizeModelKey = (value: string): string =>
  decodeURIComponent(value)
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('?')[0]
    .split('#')[0];

const getModelKeyCandidates = (value?: string): string[] => {
  if (!value) return [];
  try {
    const normalized = normalizeModelKey(value);
    const last = normalized.split('/').pop() ?? normalized;
    const withoutExt = last.replace(/\.[a-z0-9]+$/i, '');
    const candidates = new Set<string>();
    if (last) candidates.add(last);
    if (withoutExt) candidates.add(withoutExt);
    return Array.from(candidates);
  } catch {
    return [];
  }
};

// Display labels for the main 3D categories
const categoryLabels: Record<string, string> = {
  Floor: '床材',
  Wall: '壁材',
  Ceiling: '天井材',
  Furniture: '家具',
  Window: '窓'
};

// Helper to optimize Cloudinary images for thumbnails
const getThumbnailUrl = (url: string) => {
  if (url && url.includes('cloudinary.com')) {
    // c_fill は中央切り抜きでアスペクト比を崩すため、実寸表示用の比率計算には不向き。
    // c_limit で縦横比を維持した縮小画像を使う。
    return url.replace('/upload/', '/upload/w_300,h_300,c_limit/'); 
  }
  return url;
};

// Helper: Resize Image maintaining aspect ratio
const resizeImage = (base64Str: string, maxWidth: number = 1536, maxHeight: number = 1536): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = base64Str;
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      
      // Calculate new dimensions while maintaining aspect ratio
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#FFFFFF'; // Fill background white just in case transparent png
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        // Use quality 0.95 to preserve details
        resolve(canvas.toDataURL('image/jpeg', 0.95)); 
      } else {
        resolve(base64Str);
      }
    };
    img.onerror = () => resolve(base64Str);
  });
};

// --- サムネイルのサーバー保存＆メモリキャッシュシステム ---
// localStorageは廃止し、セッション中はメモリで保持する
const globalThumbnailCache: Record<string, string> = {};
const generationQueue: string[] = [];
const thumbnailEnqueueTimers = new Map<string, number>();
const cacheListeners = new Set<() => void>();
const notifyCacheUpdate = () => cacheListeners.forEach(l => l());
const PERF_TRACE = false;
const META_SOURCE_TRACE = false;
const LAMP_DEV_TRACE =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  (window as any).__LAMP_TRACE__ === true;
const PERF_THRESH_MS = {
    footprint: 50,
    thumbnail: 80
} as const;
const THUMBNAIL_RENDER_TIMEOUT_MS = 8000;

const scheduleIdleTask = (task: () => void, fallbackDelayMs = 220) => {
    if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
        const id = (window as any).requestIdleCallback(
            () => task(),
            { timeout: 1200 }
        ) as number;
        return () => {
            if (typeof (window as any).cancelIdleCallback === 'function') {
                (window as any).cancelIdleCallback(id);
            }
        };
    }
    const id = window.setTimeout(task, fallbackDelayMs);
    return () => window.clearTimeout(id);
};

export const requestThumbnail = (url: string) => {
    if (globalThumbnailCache[url] || generationQueue.includes(url) || thumbnailEnqueueTimers.has(url)) return;
    const timerId = window.setTimeout(() => {
        thumbnailEnqueueTimers.delete(url);
        if (!globalThumbnailCache[url] && !generationQueue.includes(url)) {
            generationQueue.push(url);
            notifyCacheUpdate();
        }
    }, 220);
    thumbnailEnqueueTimers.set(url, timerId);
};

const ModelThumbnailInner = ({ url, onRender }: { url: string, onRender: (dataUrl: string) => void }) => {
    const { scene } = useGLTF(url);
    const { gl, scene: threeScene, camera } = useThree();
    
    const cloned = useMemo(() => {
        const c = scene.clone();
        const box = new THREE.Box3().setFromObject(c);
        const center = box.getCenter(new THREE.Vector3());
        c.position.set(-center.x, -center.y, -center.z);
        const wrapper = new THREE.Group();
        wrapper.add(c);
        wrapper.rotation.y = Math.PI + Math.PI / 6;
        wrapper.rotation.x = Math.PI / 12;
        const sphere = new THREE.Sphere();
        box.getBoundingSphere(sphere);
        const scale = 1.8 / (sphere.radius || 1);
        wrapper.scale.setScalar(scale);
        c.traverse((child: any) => {
            if (child.isMesh) {
                child.material = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.8, metalness: 0.1 });
            }
        });
        return wrapper;
    }, [scene]);

    useEffect(() => {
        if (cloned) {
            const timer = setTimeout(() => {
                gl.render(threeScene, camera);
                // バックエンドでPNGとして保存するため、PNG形式で出力
                onRender(gl.domElement.toDataURL('image/png', 0.9));
            }, 300);
            return () => clearTimeout(timer);
        }
    }, [cloned, gl, threeScene, camera, onRender]);

    return <primitive object={cloned} />;
};

const ThumbnailGeneratorQueue = ({ enabled }: { enabled: boolean }) => {
    const [currentUrl, setCurrentUrl] = useState<string | null>(null);
    const [tick, setTick] = useState(0);
    const currentUrlRef = useRef<string | null>(null);

    useEffect(() => {
        currentUrlRef.current = currentUrl;
    }, [currentUrl]);

    useEffect(() => {
        const listener = () => setTick(t => t + 1);
        cacheListeners.add(listener);
        return () => { cacheListeners.delete(listener); };
    }, []);

    useEffect(() => {
        if (!enabled) return;
        if (!currentUrl && generationQueue.length > 0) {
            setCurrentUrl(generationQueue[0]);
        }
    }, [enabled, currentUrl, tick]);

    const dequeueCurrent = useCallback((reason: 'success' | 'timeout' | 'error') => {
        const active = currentUrlRef.current;
        if (!active) return;
        if (generationQueue[0] === active) {
            generationQueue.shift();
        } else {
            const idx = generationQueue.indexOf(active);
            if (idx >= 0) generationQueue.splice(idx, 1);
        }
        currentUrlRef.current = null;
        setCurrentUrl(null);
        notifyCacheUpdate();
        if (PERF_TRACE || LAMP_DEV_TRACE) {
            console.info('[thumbnail][dequeue]', { reason, url: active, queueLength: generationQueue.length });
        }
    }, []);

    useEffect(() => {
        if (!enabled || !currentUrl) return;
        const tid = window.setTimeout(() => {
            dequeueCurrent('timeout');
        }, THUMBNAIL_RENDER_TIMEOUT_MS);
        return () => window.clearTimeout(tid);
    }, [enabled, currentUrl, dequeueCurrent]);

    const handleRender = async (dataUrl: string) => {
        if (currentUrl) {
            const t0 = performance.now();
            globalThumbnailCache[currentUrl] = dataUrl;
            
            try {
                const fileName = getThumbnailPublicIdFromGlbUrl(currentUrl);
                await fetch('/api/thumbnails', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName, imageData: dataUrl })
                });
            } catch (e) {
                console.error('Thumbnail upload failed:', e);
            }
            dequeueCurrent('success');
            const elapsed = performance.now() - t0;
            if (PERF_TRACE && elapsed > PERF_THRESH_MS.thumbnail) {
                console.warn('[perf][thumbnail] slow generation', { elapsedMs: Math.round(elapsed), url: currentUrl });
            }
        }
    };

    if (!enabled || !currentUrl) return null;

    return (
        <div style={{ position: 'absolute', top: -9999, left: -9999, width: 256, height: 256, zIndex: -100 }}>
            <Canvas gl={{ preserveDrawingBuffer: true }} frameloop="demand">
                <ambientLight intensity={1.5} />
                <directionalLight position={[5, 10, 5]} intensity={1.5} />
                <Suspense fallback={null}>
                    <ModelThumbnailInner url={currentUrl} onRender={handleRender} />
                </Suspense>
            </Canvas>
        </div>
    );
};

const ModelThumbnail = ({ url, name }: { url?: string, name?: string }) => {
    // URLが未定義の場合はクラッシュを防ぎ、代わりのアイコンを表示する
    if (!url) return <div className="w-full h-full flex items-center justify-center bg-neutral-800"><span className="text-[10px] font-black text-neutral-500">{name?.charAt(0) || '?'}</span></div>;

    // アップロード先（/api/thumbnails）と同じ public_id 規則で PNG URL を組み立てる
    const staticImageUrl = getThumbnailImageUrlFromGlbUrl(url);

    const [imgSrc, setImgSrc] = useState(globalThumbnailCache[url] || staticImageUrl);

    useEffect(() => {
        const listener = () => {
            if (globalThumbnailCache[url] && imgSrc !== globalThumbnailCache[url]) {
                setImgSrc(globalThumbnailCache[url]);
            }
        };
        cacheListeners.add(listener);
        return () => { cacheListeners.delete(listener); };
    }, [url, imgSrc]);

    return (
        <div className="w-full h-full flex items-center justify-center bg-neutral-800 relative overflow-hidden">
            <img 
                src={imgSrc} 
                className="w-full h-full object-cover transition-opacity duration-300" 
                alt={name} 
                onError={(e) => {
                    // 画像が見つからない(404)場合のみ、バックグラウンドでの生成キューに登録
                    if (imgSrc === staticImageUrl) {
                        requestThumbnail(url);
                        e.currentTarget.style.display = 'none';
                        if (e.currentTarget.nextElementSibling) e.currentTarget.nextElementSibling.classList.remove('hidden');
                    }
                }}
                onLoad={(e) => {
                    e.currentTarget.style.display = 'block';
                    if (e.currentTarget.nextElementSibling) e.currentTarget.nextElementSibling.classList.add('hidden');
                }}
            />
            <span className="hidden text-[10px] font-black text-neutral-500 uppercase tracking-widest absolute">
                {name?.charAt(0)}
            </span>
        </div>
    );
};

const MouseLeftClick = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2C8.686 2 6 4.686 6 8v8c0 3.314 2.686 6 6 6s6-2.686 6-6V8c0-3.314-2.686-6-6-6z" />
    <path d="M12 2v6" />
    <path d="M6 8h6" className="text-emerald-400 drop-shadow-[0_0_5px_rgba(52,211,153,1)]" strokeWidth="2.5" />
  </svg>
);

const MouseRightClick = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2C8.686 2 6 4.686 6 8v8c0 3.314 2.686 6 6 6s6-2.686 6-6V8c0-3.314-2.686-6-6-6z" />
    <path d="M12 2v6" />
    <path d="M12 8h6" className="text-emerald-400 drop-shadow-[0_0_5px_rgba(52,211,153,1)]" strokeWidth="2.5" />
  </svg>
);

const MouseWheel = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2C8.686 2 6 4.686 6 8v8c0 3.314 2.686 6 6 6s6-2.686 6-6V8c0-3.314-2.686-6-6-6z" />
    <path d="M12 2v6" />
    <path d="M12 4v3" className="text-emerald-400 drop-shadow-[0_0_5px_rgba(52,211,153,1)]" strokeWidth="2.5" />
  </svg>
);

const OPENING_TYPE_LABELS: Record<string, string> = {
  window_fix: 'はめ殺し窓',
  window_sliding: '引き違い窓',
  window_casement: '縦すべり出し窓',
  door_single: '片開きドア',
  door_sliding: '引き戸',
};

const createAiEstimateItem = (): AiEstimateItem => ({
  id: `ai_est_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  name: '',
  brand: '',
  price: undefined,
  memo: '',
});

type EstimatePanelDetailScrollProps = {
  forAiEdit: boolean;
  aggregatedMaterials: any[];
  materialsTotal: number;
  activeMeshes: string[];
  materialUnitPriceOverrides: Record<string, number>;
  setMaterialUnitPriceOverrides: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  furnitureItems: any[];
  activeFurnitureId: string | null;
  setFurnitureItems: React.Dispatch<React.SetStateAction<any[]>>;
  furnitureTotal: number;
  aiEstimateItems: AiEstimateItem[];
  aiEstimateTotal: number;
  handleAddAiEstimateItem: () => void;
  handleUpdateAiEstimateItem: (id: string, patch: Partial<AiEstimateItem>) => void;
  handleRemoveAiEstimateItem: (id: string) => void;
  furnitureEstimateSectionRef: React.RefObject<HTMLDivElement | null>;
  aiEstimateSectionRef: React.RefObject<HTMLDivElement | null>;
};

const EstimatePanelDetailScroll = memo(function EstimatePanelDetailScroll({
  forAiEdit,
  aggregatedMaterials,
  materialsTotal,
  activeMeshes,
  materialUnitPriceOverrides,
  setMaterialUnitPriceOverrides,
  furnitureItems,
  activeFurnitureId,
  setFurnitureItems,
  furnitureTotal,
  aiEstimateItems,
  aiEstimateTotal,
  handleAddAiEstimateItem,
  handleUpdateAiEstimateItem,
  handleRemoveAiEstimateItem,
  furnitureEstimateSectionRef,
  aiEstimateSectionRef,
}: EstimatePanelDetailScrollProps) {
  const hasAnyRows =
    aggregatedMaterials.length > 0 || furnitureItems.length > 0 || aiEstimateItems.length > 0;

  if (!hasAnyRows) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center opacity-40 pb-8">
        <p className="text-[10px] font-black">素材が選択されていません</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {aggregatedMaterials.length > 0 && (
        <div>
          <div className="flex items-center justify-between border-b border-white/10 pb-1.5 mb-2.5 px-1">
            <span className="text-[10px] font-black tracking-widest text-neutral-400">建材</span>
            <span className="text-[11px] font-mono font-bold text-white">¥{Math.round(materialsTotal).toLocaleString()}</span>
          </div>
          <div
            className={`grid gap-2 md:gap-3 ${
              forAiEdit ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 2xl:grid-cols-2'
            }`}
          >
            {aggregatedMaterials.map((item: any, i: number) => {
              const isHighlighted = item.meshNames.some((m: string) => activeMeshes.includes(m));
              return (
                <div
                  key={`mat-${item.productId ?? i}`}
                  className={`p-2.5 rounded-xl border flex flex-col justify-between transition-all ${
                    isHighlighted
                      ? 'bg-emerald-500/10 border-emerald-500/50 shadow-lg scale-[1.02]'
                      : 'bg-white/5 border-white/5 hover:border-white/10'
                  }`}
                >
                  <div className="flex items-start gap-2 mb-2">
                    <img src={getThumbnailUrl(item.textureUrl)} className="w-8 h-8 rounded-lg object-cover bg-neutral-800 shrink-0" alt="" />
                    <div className="min-w-0 flex-1">
                      <div className={`text-[8px] font-black uppercase truncate ${isHighlighted ? 'text-emerald-400' : 'text-neutral-500'}`}>{item.brand}</div>
                      <div className="text-[9px] text-white font-bold leading-tight truncate">{item.prodName}</div>
                    </div>
                  </div>
                  <div className="flex justify-between items-end border-t border-white/5 pt-1.5 mt-1">
                    <div className="text-[9px] font-mono text-neutral-500">{item.area.toFixed(1)}㎡</div>
                    <div className={`text-xs font-mono font-bold ${isHighlighted ? 'text-emerald-400' : 'text-white'}`}>¥{Math.round(item.cost).toLocaleString()}</div>
                  </div>
                  <div className="mt-2 flex items-center gap-1">
                    <span className="text-[9px] font-bold text-neutral-400">㎡単価</span>
                    <input
                      value={materialUnitPriceOverrides[item.productId] ?? item.unitPrice ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        const next = raw === '' ? undefined : Math.max(0, Number(raw) || 0);
                        setMaterialUnitPriceOverrides((prev) => {
                          const copy = { ...prev };
                          if (next == null) delete copy[item.productId];
                          else copy[item.productId] = next;
                          return copy;
                        });
                      }}
                      className="w-full rounded bg-black/40 px-2 py-1 text-[10px] text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400/60"
                    />
                    <span className="text-[9px] font-bold text-neutral-500">円/㎡</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {furnitureItems.length > 0 && (
        <div ref={furnitureEstimateSectionRef}>
          <div className="flex items-center justify-between border-b border-white/10 pb-1.5 mb-2.5 px-1">
            <span className="text-[10px] font-black tracking-widest text-neutral-400">インテリア</span>
            <span className="text-[11px] font-mono font-bold text-white">¥{Math.round(furnitureTotal).toLocaleString()}</span>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
            {furnitureItems.map((f: any) => {
              const isHighlighted = f.id === activeFurnitureId;
              return (
                <div
                  key={`furn-${f.id}`}
                  className={`p-2.5 rounded-xl border flex flex-col justify-between transition-all ${
                    isHighlighted
                      ? 'bg-emerald-500/10 border-emerald-500/50 shadow-lg scale-[1.02]'
                      : 'bg-white/5 border-white/5 hover:border-white/10'
                  }`}
                >
                  <div className="flex items-start gap-2 mb-2">
                    <div className="w-8 h-8 rounded-lg bg-neutral-800 flex items-center justify-center text-neutral-500 shrink-0 border border-white/10 overflow-hidden">
                      <ModelThumbnail url={f.modelUrl} name={f.customName || f.name || f.type} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`text-[8px] font-black uppercase truncate ${isHighlighted ? 'text-emerald-400' : 'text-neutral-500'}`}>{f.customBrand || f.type || 'FURNITURE'}</div>
                      <div className="text-[9px] text-white font-bold leading-tight truncate">{f.customName || f.name}</div>
                    </div>
                  </div>
                  <div className="flex justify-between items-end border-t border-white/5 pt-1.5 mt-1">
                    <div className="text-[9px] font-mono text-neutral-500">1 個</div>
                    <div className={`text-xs font-mono font-bold ${isHighlighted ? 'text-emerald-400' : 'text-white'}`}>¥{(f.customPrice || 0).toLocaleString()}</div>
                  </div>
                  <div className="mt-2 flex items-center gap-1">
                    <span className="text-[9px] font-bold text-neutral-400">1個単価</span>
                    <input
                      value={f.customPrice ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        setFurnitureItems((prev) =>
                          prev.map((item) =>
                            item.id === f.id ? { ...item, customPrice: raw === '' ? undefined : Math.max(0, Number(raw) || 0) } : item
                          )
                        );
                      }}
                      className="w-full rounded bg-black/40 px-2 py-1 text-[10px] text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400/60"
                    />
                    <span className="text-[9px] font-bold text-neutral-500">円/個</span>
                  </div>
                  {!(f.customPrice && f.customPrice > 0) && (
                    <div className="mt-1 text-[10px] font-black text-amber-300">価格未入力</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div ref={aiEstimateSectionRef}>
        <div className="flex items-center justify-between border-b border-white/10 pb-1.5 mb-2.5 px-1">
          <span className="text-[10px] font-black tracking-widest text-neutral-400">AI追加アイテム</span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-bold text-white">¥{Math.round(aiEstimateTotal).toLocaleString()}</span>
            <button
              type="button"
              onClick={handleAddAiEstimateItem}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-black text-emerald-300 hover:bg-emerald-500/20"
            >
              + 追加
            </button>
          </div>
        </div>
        {aiEstimateItems.length > 0 ? (
          <div className="grid grid-cols-1 gap-2">
            {aiEstimateItems.map((item) => {
              const missing = !item.name.trim() || !item.brand.trim() || !(item.price && item.price > 0);
              return (
                <div key={item.id} className={`rounded-xl border p-2 ${missing ? 'border-amber-500/40 bg-amber-500/5' : 'border-white/10 bg-white/5'}`}>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                    <input
                      value={item.name}
                      onChange={(e) => handleUpdateAiEstimateItem(item.id, { name: e.target.value })}
                      placeholder="名称"
                      className="sm:col-span-4 rounded bg-black/40 px-2 py-1 text-[10px] text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400/60"
                    />
                    <input
                      value={item.brand}
                      onChange={(e) => handleUpdateAiEstimateItem(item.id, { brand: e.target.value })}
                      placeholder="ブランド/メーカー"
                      className="sm:col-span-4 rounded bg-black/40 px-2 py-1 text-[10px] text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400/60"
                    />
                    <input
                      value={item.price ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        handleUpdateAiEstimateItem(item.id, { price: raw === '' ? undefined : Math.max(0, Number(raw) || 0) });
                      }}
                      placeholder="金額"
                      className="sm:col-span-3 rounded bg-black/40 px-2 py-1 text-[10px] text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400/60"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveAiEstimateItem(item.id)}
                      className="sm:col-span-1 rounded border border-red-500/30 bg-red-500/10 text-[10px] font-black text-red-300 hover:bg-red-500/20"
                    >
                      削除
                    </button>
                  </div>
                  {missing && <div className="mt-1 text-[10px] font-black text-amber-300">名称・ブランド・金額の入力で完了になります</div>}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-[10px] font-bold text-neutral-500">
            AI編集で追加した項目を +追加 から登録できます
          </div>
        )}
      </div>
      <div className="text-right mt-1">
        <span className="text-[8px] text-neutral-600 font-bold uppercase">※建材はロス率込み</span>
      </div>
    </div>
  );
});

const App: React.FC = () => {
  // サムネイルキャッシュ／キュー更新で再レンダーし、ThumbnailGeneratorQueue の enabled を評価する
  const [cacheTrigger, setCacheTrigger] = useState(0);
  useEffect(() => {
    const bump = () => setCacheTrigger((t) => t + 1);
    cacheListeners.add(bump);
    return () => {
      cacheListeners.delete(bump);
    };
  }, []);

  const [viewMode, setViewMode] = useState<ViewMode>('sketch');
  // 下絵（2D背景画像）もストア管理（永続化対象）。
  const underlay = useProjectStore((s) => s.sketch.underlay);
  // 梁（天井レイヤ）もストア管理（永続化・Undo対象）。
  const beams = useProjectStore((s) => s.scene.beams);
  // sketchPoints の真実源も統合ストア（Undo/Redo 対象）。setState 互換 API は維持。
  const sketchPoints = useProjectStore((s) => s.sketch.points) as SketchPoint[];
  const setSketchPoints = useCallback<React.Dispatch<React.SetStateAction<SketchPoint[]>>>(
    (action) => {
      const current = useProjectStore.getState().sketch.points as SketchPoint[];
      const next =
        typeof action === 'function'
          ? (action as (prev: SketchPoint[]) => SketchPoint[])(current)
          : action;
      useProjectStore.getState().setSketchPoints(next);
    },
    []
  );
  const [pendingPoints, setPendingPoints] = useState<SketchPoint[]>([]);
  const [isClosedPending, setIsClosedPending] = useState(false);
  // selections（メッシュ→製品）の真実源も統合ストア（Undo/Redo 対象）。setState 互換 API は維持。
  const selections = useProjectStore((s) => s.materials.selections);
  const setSelections = useCallback<React.Dispatch<React.SetStateAction<Record<string, Product | null>>>>(
    (action) => {
      const current = useProjectStore.getState().materials.selections;
      const next =
        typeof action === 'function'
          ? (action as (prev: Record<string, Product | null>) => Record<string, Product | null>)(current)
          : action;
      useProjectStore.getState().setSelections(next);
    },
    []
  );
  const [roomHeight, setRoomHeight] = useState(2700);
  // スケルトン天井: 天井スラブを外して梁などの上部構造を露出する（3Dビュー）。
  const [skeletonCeiling, setSkeletonCeiling] = useState(false);
  
  // Snap Settings
  const [gridSnapSize, setGridSnapSize] = useState(1000); 
  const [lengthSnapSize, setLengthSnapSize] = useState(1000);
  const [isLengthSnapEnabled, setIsLengthSnapEnabled] = useState(true);
  const [angleSnapSize, setAngleSnapSize] = useState(45); 
  const [isAngleSnapEnabled, setIsAngleSnapEnabled] = useState(true);
  
  const [customModelUrl, setCustomModelUrl] = useState<string | null>(null);
  
  const [activeCategory, setActiveCategory] = useState<MaterialCategory | null>(null);
  // activeMeshを複数選択対応のactiveMeshesに変更
  const [activeMeshes, setActiveMeshes] = useState<string[]>([]);
  // wallDivisions の真実源も統合ストア（Undo/Redo・永続化対象）。setState 互換 API は維持。
  const wallDivisions = useProjectStore((s) => s.sketch.wallDivisions);
  const setWallDivisions = useCallback<React.Dispatch<React.SetStateAction<Record<number, number>>>>(
    (action) => {
      const current = useProjectStore.getState().sketch.wallDivisions;
      const next =
        typeof action === 'function'
          ? (action as (prev: Record<number, number>) => Record<number, number>)(current)
          : action;
      useProjectStore.getState().setWallDivisions(next);
    },
    []
  );
  
  // Furniture State — 真実源は統合ストア（Zustand）。setFurnitureItems の API（値 or 更新関数）は
  // 互換のまま維持し、書き込みをストアにブリッジする（既存の全呼び出し箇所はそのまま動作し、
  // かつ Undo/Redo の対象になる）。
  const furnitureItems = useProjectStore((s) => s.scene.furniture);
  const setFurnitureItems = useCallback<React.Dispatch<React.SetStateAction<FurnitureItem[]>>>(
    (action) => {
      const current = useProjectStore.getState().scene.furniture;
      const next =
        typeof action === 'function'
          ? (action as (prev: FurnitureItem[]) => FurnitureItem[])(current)
          : action;
      useProjectStore.getState().setFurniture(next);
    },
    []
  );
  /** 3D 側の連続更新をメインスレッドでブロックしにくくする（2D は直接 setFurnitureItems のまま） */
  const setFurnitureItemsFrom3D = useCallback(
    (action: React.SetStateAction<FurnitureItem[]>) => {
      startTransition(() => setFurnitureItems(action));
    },
    [setFurnitureItems]
  );
  // キーボードショートカット（Ctrl+Z / Ctrl+Shift+Z・Ctrl+Y / Ctrl+G）。
  // ※現時点では家具スライドのみストア管理のため、Undo/Redo は家具に対して有効。
  useEditorShortcuts();
  const furnitureFootprintAttemptedRef = useRef<Set<string>>(new Set());
  const furnitureItemsRef = useRef<FurnitureItem[]>(furnitureItems);
  furnitureItemsRef.current = furnitureItems;

  /** 足跡未設定・modelUrl 等が変わったときだけ GLTF スキャン用 effect を走らせる（位置更新のたびに forEach しない） */
  const furnitureItemsFootprintScanKey = useMemo(
    () =>
      furnitureItems
        .map((i) => `${i.id}\u200c${i.modelUrl ?? ''}\u200c${i.modelFootprintBaseMm ? '1' : '0'}`)
        .sort()
        .join('|'),
    [furnitureItems]
  );

  const [activeFurnitureId, setActiveFurnitureId] = useState<string | null>(null);
  const [furnitureCatalog, setFurnitureCatalog] = useState<FurnitureCatalogItem[]>([]);
  const [furnitureCatalogFetchStatus, setFurnitureCatalogFetchStatus] = useState<FurnitureCatalogFetchStatus>('loading');
  const [furnitureCatalogErrorText, setFurnitureCatalogErrorText] = useState<string | null>(null);
  const [furnitureMetadataMap, setFurnitureMetadataMap] = useState<FurnitureModelMetadataMap>({});
  // openings の真実源も統合ストア（Undo/Redo 対象）。setState 互換 API は維持。
  const openings = useProjectStore((s) => s.sketch.openings);
  const setOpenings = useCallback<React.Dispatch<React.SetStateAction<Opening[]>>>(
    (action) => {
      const current = useProjectStore.getState().sketch.openings;
      const next =
        typeof action === 'function'
          ? (action as (prev: Opening[]) => Opening[])(current)
          : action;
      useProjectStore.getState().setOpenings(next);
    },
    []
  );
  const [selectedOpeningId, setSelectedOpeningId] = useState<string | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>('draw');
  const [addKind, setAddKind] = useState<AddKind>('door');

  // Dynamic Filter States
  const [selectedBrand, setSelectedBrand] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>('default');

  // UI States
  const [showCostPanel, setShowCostPanel] = useState(false);
  const [aiEstimateItems, setAiEstimateItems] = useState<AiEstimateItem[]>([]);
  const [materialUnitPriceOverrides, setMaterialUnitPriceOverrides] = useState<Record<string, number>>({});
  const [estimateGuardOpen, setEstimateGuardOpen] = useState(false);
  const [pendingExportKind, setPendingExportKind] = useState<'pdf' | 'csv' | null>(null);
  const [showDebugModal, setShowDebugModal] = useState(false);
  const [catalogGridSize, setCatalogGridSize] = useState(2); // grid columns via 5 - size; slider maps with CATALOG_SLIDER_TO_GRID
  const [catalogSortMenuOpen, setCatalogSortMenuOpen] = useState(false);
  const catalogSortMenuRef = useRef<HTMLDivElement>(null);
  const [estimateDownloadMenuOpen, setEstimateDownloadMenuOpen] = useState(false);
  const estimateDownloadMenuRef = useRef<HTMLDivElement>(null);
  const [textureImageSizes, setTextureImageSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [detectedTextureShortEdgeMmByProductId, setDetectedTextureShortEdgeMmByProductId] = useState<Record<string, number>>({});
  const textureSizeLoadingByProductIdRef = useRef<Record<string, boolean>>({});
  const [outsideBackgroundPreset, setOutsideBackgroundPreset] = useState<OutsideBackgroundPreset>('day');
  const furnitureEstimateSectionRef = useRef<HTMLDivElement | null>(null);
  const aiEstimateSectionRef = useRef<HTMLDivElement | null>(null);

  const ensureOriginalTextureSize = useCallback((prodId: string, originalUrl: string) => {
    const cached = textureImageSizes[prodId];
    if (cached || textureSizeLoadingByProductIdRef.current[prodId]) return;
    textureSizeLoadingByProductIdRef.current[prodId] = true;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (w > 0 && h > 0) {
        setTextureImageSizes((prev) => {
          const current = prev[prodId];
          if (current && current.width === w && current.height === h) return prev;
          return { ...prev, [prodId]: { width: w, height: h } };
        });
        setDetectedTextureShortEdgeMmByProductId((prev) => {
          const shortEdgeMm = Math.round(Math.min(w, h));
          if (prev[prodId] === shortEdgeMm) return prev;
          return { ...prev, [prodId]: shortEdgeMm };
        });
      }
      textureSizeLoadingByProductIdRef.current[prodId] = false;
    };
    img.onerror = () => {
      textureSizeLoadingByProductIdRef.current[prodId] = false;
    };
    img.src = originalUrl;
  }, [textureImageSizes]);

  const getSidecarMetaByUrl = useCallback(
    (url?: string): FurnitureModelMetadataEntry | undefined => {
      const candidates = getModelKeyCandidates(url);
      for (const key of candidates) {
        const hit = furnitureMetadataMap[key];
        if (hit) return hit;
      }
      return undefined;
    },
    [furnitureMetadataMap]
  );

  const resolveFurnitureMetadata = useCallback(
    (
      catalogItem: FurnitureCatalogItem
    ): { widthMm: number; depthMm: number; forwardYawDeg: number; source: 'api' | 'sidecar' | 'fallback' } => {
      const apiWidth = catalogItem?.footprint2d?.widthMm;
      const apiDepth = catalogItem?.footprint2d?.depthMm;
      const apiYaw = catalogItem?.forwardYawDeg;

      if (Number.isFinite(apiWidth) && Number.isFinite(apiDepth)) {
        return {
          widthMm: Number(apiWidth),
          depthMm: Number(apiDepth),
          forwardYawDeg: Number.isFinite(apiYaw) ? Number(apiYaw) : 0,
          source: 'api'
        };
      }

      const sidecar = getSidecarMetaByUrl(catalogItem?.url);
      if (Number.isFinite(sidecar?.widthMm) && Number.isFinite(sidecar?.depthMm)) {
        return {
          widthMm: Number(sidecar?.widthMm),
          depthMm: Number(sidecar?.depthMm),
          forwardYawDeg: Number.isFinite(sidecar?.forwardYawDeg) ? Number(sidecar?.forwardYawDeg) : 0,
          source: 'sidecar'
        };
      }

      return {
        widthMm: DEFAULT_FOOTPRINT_2D_MM.widthMm,
        depthMm: DEFAULT_FOOTPRINT_2D_MM.depthMm,
        forwardYawDeg: Number.isFinite(apiYaw) ? Number(apiYaw) : 0,
        source: 'fallback'
      };
    },
    [getSidecarMetaByUrl]
  );

  const normalizeFurnitureCatalogItem = useCallback((raw: any): FurnitureCatalogItem | null => {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `furniture-${Date.now()}-${Math.random()}`;
    const type = typeof raw.type === 'string' ? raw.type : 'Furniture';
    const name = typeof raw.name === 'string' ? raw.name : 'furniture';
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (!url) return null;

    const defaultScale = Number.isFinite(raw.defaultScale) ? Number(raw.defaultScale) : 1;
    const defaultY = Number.isFinite(raw.defaultY) ? Number(raw.defaultY) : 0;
    const forwardYawDeg = Number.isFinite(raw.forwardYawDeg) ? Number(raw.forwardYawDeg) : 0;

    const widthMm = raw?.footprint2d?.widthMm;
    const depthMm = raw?.footprint2d?.depthMm;
    const footprint2d =
      Number.isFinite(widthMm) && Number.isFinite(depthMm)
        ? { widthMm: Number(widthMm), depthMm: Number(depthMm) }
        : undefined;

    return { id, type, name, url, defaultScale, defaultY, footprint2d, forwardYawDeg };
  }, []);

  // Keyboard listener for deletion
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedOpeningId) {
        // Don't delete if typing in an input
        if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
        
        setOpenings(prev => prev.filter(o => o.id !== selectedOpeningId));
        setSelectedOpeningId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedOpeningId]);

  useEffect(() => {
    if (!catalogSortMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (catalogSortMenuRef.current && !catalogSortMenuRef.current.contains(e.target as Node)) {
        setCatalogSortMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [catalogSortMenuOpen]);

  useEffect(() => {
    if (!estimateDownloadMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (estimateDownloadMenuRef.current && !estimateDownloadMenuRef.current.contains(e.target as Node)) {
        setEstimateDownloadMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [estimateDownloadMenuOpen]);

  // 生成が必要な全URLリスト
  const allUrls = useMemo(() => Array.from(new Set(furnitureCatalog.map(i => i.url))), [furnitureCatalog]);

  const [selectedAssetCategory, setSelectedAssetCategory] = useState<string | null>(null);
  
  // URLのファイル名からカテゴリを自動判定し、日本語化する
  const processedCatalog = useMemo(() => {
        return furnitureCatalog.map(item => {
            const urlParts = item.url.split('/');
            const fileNameWithExt = decodeURIComponent(urlParts[urlParts.length - 1]);
            const fileName = fileNameWithExt.split('.')[0]; 
            
            // 末尾の「_数字」だけを切り落とす (例: floor_lamp_1 -> floor_lamp)
            const baseName = fileName.replace(/_\d+$/, '').toLowerCase();
            
            const enToJp: Record<string, string> = {
                'sofa': 'ソファ', 'chair': 'チェア', 'table': 'テーブル', 'desk': 'デスク',
                'floor_lamp': 'フロアランプ', 'ceiling_lamp': 'シーリングライト', 'pendant_light': 'ペンダントライト',
                'lamp': '照明', 'light': '照明', 'bed': 'ベッド', 'plant': '植物',
                'rug': 'ラグ', 'shelf': 'シェルフ', 'storage': '収納', 'cabinet': 'キャビネット',
                'tv_board': 'TVボード'
            };

            let jpCategory = enToJp[baseName];
            if (!jpCategory) {
                // 辞書にない場合はアンダースコアをスペースにして先頭大文字化
                // 補足: APIから来た item.type を使う
                jpCategory = enToJp[item.type.toLowerCase()] || (item.type.charAt(0).toUpperCase() + item.type.slice(1));
            }
            return { ...item, type: jpCategory };
        });
    }, [furnitureCatalog]);

  const assetCategories = useMemo(() => {
    return Array.from(new Set(processedCatalog.map(item => item.type)));
  }, [processedCatalog]);

  const [hideFurniture, setHideFurniture] = useState(false);

  // Data State
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // マテリアルごとのツヤ・金属・巾木設定（キーは productId）
  // materialSettings（productId→設定）の真実源も統合ストア（Undo/Redo 対象）。setState 互換 API は維持。
  const materialSettings = useProjectStore((s) => s.materials.materialSettings);
  const setMaterialSettings = useCallback<React.Dispatch<React.SetStateAction<Record<string, MaterialSettingsValue>>>>(
    (action) => {
      const current = useProjectStore.getState().materials.materialSettings;
      const next =
        typeof action === 'function'
          ? (action as (prev: Record<string, MaterialSettingsValue>) => Record<string, MaterialSettingsValue>)(current)
          : action;
      useProjectStore.getState().setMaterialSettings(next);
    },
    []
  );
  const OPENINGS_MATERIAL_KEY = '__openings__';

  const [isDenoising, setIsDenoising] = useState(false);
  const [maskMode, setMaskMode] = useState(false);
  const [aiEditOpen, setAiEditOpen] = useState(false);

  const aiEditSession = useAiEditSession();

  const {
    renderState,
    setRenderState,
    captureStep,
    setCaptureStep,
    snapshotMode,
    setSnapshotMode,
    error,
    setError,
    handleInstantRender,
  } = useAiRenderer({
    onCanvasRenderSuccess: (url) => {
      aiEditSession.clearSession();
      aiEditSession.addVersionFromRender(url);
      // レンダ完了後（ローディング解除後）に AI 編集へ遷移
      setAiEditOpen(true);
    },
  });

  const { versions: aiEditVersions } = aiEditSession;
  useEffect(() => {
    setRenderState((prev) => {
      if (prev.resultImageUrl) return prev;
      if (aiEditVersions.length === 0) return prev;
      const last = aiEditVersions[aiEditVersions.length - 1];
      return { ...prev, resultImageUrl: last.outputImageDataUrl };
    });
  }, [aiEditVersions]);

  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orbitControlsRef = useRef<OrbitControlsImpl | null>(null);
  const cameraBlendTokenRef = useRef(0);
  const [cameraBlendRequest, setCameraBlendRequest] = useState<CameraBlendRequest | null>(null);
  const [lastAppliedPresetId, setLastAppliedPresetId] = useState<string | null>(null);
  const [cameraPresets, setCameraPresets] = useState<CameraPreset[]>(() => {
    try {
      const raw = localStorage.getItem(CAMERA_PRESETS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (p: unknown): p is CameraPreset =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as CameraPreset).id === 'string' &&
          typeof (p as CameraPreset).label === 'string' &&
          Array.isArray((p as CameraPreset).position) &&
          (p as CameraPreset).position.length === 3 &&
          Array.isArray((p as CameraPreset).target) &&
          (p as CameraPreset).target.length === 3 &&
          typeof (p as CameraPreset).fov === 'number'
      );
    } catch {
      return [];
    }
  });

  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  const [cameraFov, setCameraFov] = useState(50);
  const [eyeHeightMm, setEyeHeightMm] = useState(1500);
  const [walkSessionKey, setWalkSessionKey] = useState(0);
  const [walkInitialYaw, setWalkInitialYaw] = useState(0);
  const [walkInitialPitch, setWalkInitialPitch] = useState(0);
  const [walkSpawnXZ, setWalkSpawnXZ] = useState<[number, number] | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(CAMERA_PRESETS_STORAGE_KEY, JSON.stringify(cameraPresets));
    } catch {
      /* quota / private mode */
    }
  }, [cameraPresets]);

  const requestCameraBlend = useCallback(
    (position: [number, number, number], target: [number, number, number], fov: number) => {
      cameraBlendTokenRef.current += 1;
      setCameraBlendRequest({
        token: cameraBlendTokenRef.current,
        position,
        target,
        fov,
      });
    },
    []
  );

  const handleCameraBlendComplete = useCallback(() => {
    setCameraBlendRequest(null);
    const cam = cameraRef.current;
    if (cam) setCameraFov(cam.fov);
  }, []);

  const pendingOrbitPresetRef = useRef<CameraPreset | null>(null);

  const walkDigitalInputRef = useRef({ forward: 0, strafe: 0 });
  const cameraWalkStateRef = useRef({ yaw: 0, pitch: 0 });

  const prevCameraModeRef = useRef<CameraMode>('orbit');

  const handleCameraModeChange = useCallback(
    (mode: CameraMode) => {
      const cam = cameraRef.current;
      if (mode === 'walk') {
        const ctrl = orbitControlsRef.current;
        let yaw = 0;
        if (cam && ctrl) {
          const to = new THREE.Vector3().subVectors(ctrl.target, cam.position);
          to.y = 0;
          if (to.lengthSq() > 1e-6) {
            to.normalize();
            yaw = Math.atan2(-to.x, -to.z);
          }
        } else if (cam) {
          const dir = new THREE.Vector3();
          cam.getWorldDirection(dir);
          dir.y = 0;
          if (dir.lengthSq() > 1e-6) {
            dir.normalize();
            yaw = Math.atan2(-dir.x, -dir.z);
          }
        }
        setWalkInitialYaw(yaw);
        setWalkInitialPitch(0);
        if (sketchPoints.length >= 3) {
          setWalkSpawnXZ(null);
        } else if (cam) {
          setWalkSpawnXZ([cam.position.x, cam.position.z]);
        } else {
          setWalkSpawnXZ([0, 0]);
        }
        setWalkSessionKey((k) => k + 1);
      }
      setCameraMode(mode);
    },
    [sketchPoints.length]
  );

  useEffect(() => {
    let cancelRaf: (() => void) | undefined;
    if (prevCameraModeRef.current === 'walk' && cameraMode === 'orbit') {
      const id = requestAnimationFrame(() => {
        const cam = cameraRef.current;
        const ctrl = orbitControlsRef.current;
        const st = cameraWalkStateRef.current;
        if (cam && ctrl) {
          const fwd = lookDirection(st.yaw, st.pitch);
          ctrl.target.copy(cam.position).addScaledVector(fwd, 2.5);
          ctrl.update();
        }
      });
      cancelRaf = () => cancelAnimationFrame(id);
    }
    prevCameraModeRef.current = cameraMode;
    return () => {
      cancelRaf?.();
    };
  }, [cameraMode]);

  useEffect(() => {
    if (cameraMode !== 'orbit') {
      setCameraBlendRequest(null);
    }
  }, [cameraMode]);

  const applyCameraPreset = useCallback(
    (preset: CameraPreset) => {
      setLastAppliedPresetId(preset.id);
      const isWalkPreset = preset.cameraMode === 'walk' || preset.walkYaw !== undefined;
      const isOrbitPreset = preset.cameraMode === 'orbit';
      const isFreePreset =
        preset.cameraMode === 'free' ||
        preset.freeYaw !== undefined ||
        (!isWalkPreset && !isOrbitPreset);

      if (isWalkPreset) {
        setCameraFov(preset.fov);
        setEyeHeightMm(Math.round(preset.position[1] * 1000));
        setWalkInitialYaw(preset.walkYaw ?? 0);
        setWalkInitialPitch(preset.walkPitch ?? 0);
        setWalkSpawnXZ([preset.position[0], preset.position[2]]);
        setWalkSessionKey((k) => k + 1);
        setCameraMode('walk');
        return;
      }
      if (isFreePreset) {
        const fallbackYaw =
          preset.freeYaw ??
          (() => {
            const dx = preset.target[0] - preset.position[0];
            const dz = preset.target[2] - preset.position[2];
            if (Math.hypot(dx, dz) < 1e-6) return 0;
            return Math.atan2(-dx, -dz);
          })();
        const fallbackPitch =
          preset.freePitch ??
          (() => {
            const dir = new THREE.Vector3(
              preset.target[0] - preset.position[0],
              preset.target[1] - preset.position[1],
              preset.target[2] - preset.position[2]
            );
            if (dir.lengthSq() < 1e-8) return 0;
            dir.normalize();
            return Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
          })();
        const fallbackTargetVec = lookDirection(fallbackYaw, fallbackPitch)
          .multiplyScalar(2.5)
          .add(new THREE.Vector3(...preset.position));
        const fallbackTarget: [number, number, number] = [
          fallbackTargetVec.x,
          fallbackTargetVec.y,
          fallbackTargetVec.z,
        ];
        const fallbackOrbitPreset: CameraPreset = {
          ...preset,
          cameraMode: 'orbit',
          target: fallbackTarget,
        };
        if (cameraMode !== 'orbit') {
          pendingOrbitPresetRef.current = fallbackOrbitPreset;
          setCameraMode('orbit');
          return;
        }
        setCameraFov(fallbackOrbitPreset.fov);
        requestCameraBlend(fallbackOrbitPreset.position, fallbackOrbitPreset.target, fallbackOrbitPreset.fov);
        return;
      }

      if (cameraMode !== 'orbit') {
        pendingOrbitPresetRef.current = preset;
        setCameraMode('orbit');
        return;
      }

      setCameraFov(preset.fov);
      requestCameraBlend(preset.position, preset.target, preset.fov);
    },
    [cameraMode, requestCameraBlend]
  );

  useEffect(() => {
    if (cameraMode !== 'orbit') return;
    const pending = pendingOrbitPresetRef.current;
    if (!pending) return;
    const id = requestAnimationFrame(() => {
      if (pendingOrbitPresetRef.current !== pending) return;
      pendingOrbitPresetRef.current = null;
      setCameraFov(pending.fov);
      requestCameraBlend(pending.position, pending.target, pending.fov);
    });
    return () => cancelAnimationFrame(id);
  }, [cameraMode, requestCameraBlend]);

  const handleSaveCameraPreset = useCallback(() => {
    const cam = cameraRef.current;
    if (!cam) return;
    const suggested = `視点 ${cameraPresets.length + 1}`;
    const label = window.prompt('視点名', suggested);
    if (label === null) return;
    const trimmed = label.trim() || suggested;

    if (cameraMode === 'walk') {
      const st = cameraWalkStateRef.current;
      const preset: CameraPreset = {
        id: crypto.randomUUID(),
        label: trimmed,
        cameraMode: 'walk',
        position: [cam.position.x, cam.position.y, cam.position.z],
        target: [cam.position.x, cam.position.y, cam.position.z],
        walkYaw: st.yaw,
        walkPitch: st.pitch,
        fov: cam.fov,
      };
      setCameraPresets((prev) => {
        const next = [...prev, preset];
        return next.length > MAX_CAMERA_PRESETS ? next.slice(-MAX_CAMERA_PRESETS) : next;
      });
      setLastAppliedPresetId(preset.id);
      return;
    }
    const ctrl = orbitControlsRef.current;
    if (!ctrl) return;
    const preset: CameraPreset = {
      id: crypto.randomUUID(),
      label: trimmed,
      cameraMode: 'orbit',
      position: [cam.position.x, cam.position.y, cam.position.z],
      target: [ctrl.target.x, ctrl.target.y, ctrl.target.z],
      fov: cam.fov,
    };
    setCameraPresets((prev) => {
      const next = [...prev, preset];
      return next.length > MAX_CAMERA_PRESETS ? next.slice(-MAX_CAMERA_PRESETS) : next;
    });
    setLastAppliedPresetId(preset.id);
  }, [cameraPresets.length, cameraMode]);

  const handleDeleteCameraPreset = useCallback((id: string) => {
    setCameraPresets((prev) => prev.filter((p) => p.id !== id));
    setLastAppliedPresetId((cur) => (cur === id ? null : cur));
  }, []);

  const handleRenameCameraPreset = useCallback(
    (id: string) => {
      const preset = cameraPresets.find((p) => p.id === id);
      if (!preset) return;
      const next = window.prompt('視点名', preset.label);
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed) return;
      setCameraPresets((prev) => prev.map((p) => (p.id === id ? { ...p, label: trimmed } : p)));
    },
    [cameraPresets]
  );

  // 1. Fetch Products dynamically from API
  useEffect(() => {
    const fetchProducts = async () => {
      setIsLoadingProducts(true);
      setFetchError(null);
      try {
        const res = await fetch('/api/materials');
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        
        const data = await res.json();
        
        if (Array.isArray(data) && data.length > 0) {
            setProducts(data);
        } else {
            console.warn("API returned empty data.");
            setProducts([]); // ダミー素材を廃止し、空配列にする
        }
      } catch (e: any) {
        console.error("Material fetch error:", e);
        // エラー時もダミー素材を読み込まず、空の状態（ユーザーの独自アップロードのみ）にする
        setProducts([]);
      } finally {
        setIsLoadingProducts(false);
      }
    };
    fetchProducts();
  }, []);

  // Fetch Furniture dynamically from API（本番=Cloudinary）。
  // Cloudinary 未構成/空/失敗時は、同梱の静的カタログ public/models/catalog.json に
  // フォールバックして家具を表示する（Cloudinary が有効ならそちらを優先）。
  useEffect(() => {
    const normalizeRows = (data: unknown): FurnitureCatalogItem[] => {
      const rows = Array.isArray(data)
        ? data
        : Array.isArray((data as { items?: unknown })?.items)
          ? (data as { items: unknown[] }).items
          : [];
      return Array.isArray(rows)
        ? rows
            .map((item) => normalizeFurnitureCatalogItem(item))
            .filter((item): item is FurnitureCatalogItem => item !== null)
        : [];
    };

    const loadBundledFallback = async (): Promise<FurnitureCatalogItem[]> => {
      try {
        const res = await fetch('/models/catalog.json');
        if (!res.ok) return [];
        return normalizeRows(await res.json());
      } catch {
        return [];
      }
    };

    const fetchFurniture = async () => {
      setFurnitureCatalogFetchStatus('loading');
      setFurnitureCatalogErrorText(null);
      try {
        const res = await fetch('/api/furniture');
        const bodyText = await res.text();
        let parsed: unknown;
        try {
          parsed = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          parsed = null;
        }
        const normalized = res.ok ? normalizeRows(parsed) : [];
        if (normalized.length > 0) {
          setFurnitureCatalog(normalized);
          setFurnitureCatalogFetchStatus('ready');
          return;
        }
        // Cloudinary が未構成/空でも同梱モデルで継続。
        const fallback = await loadBundledFallback();
        if (fallback.length > 0) {
          setFurnitureCatalog(fallback);
          setFurnitureCatalogFetchStatus('ready');
          return;
        }
        const msg =
          parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
            ? (parsed as { error: string }).error
            : `HTTP ${res.status}`;
        console.error('[furniture catalog]', res.status, bodyText.slice(0, 500));
        setFurnitureCatalogErrorText(msg);
        setFurnitureCatalogFetchStatus('error');
      } catch (e) {
        // ネットワーク等の例外時も同梱モデルで継続を試みる。
        const fallback = await loadBundledFallback();
        if (fallback.length > 0) {
          setFurnitureCatalog(fallback);
          setFurnitureCatalogFetchStatus('ready');
          return;
        }
        console.error('Furniture fetch error:', e);
        setFurnitureCatalogErrorText(e instanceof Error ? e.message : 'NETWORK_ERROR');
        setFurnitureCatalogFetchStatus('error');
      }
    };
    fetchFurniture();
  }, [normalizeFurnitureCatalogItem]);

  // 家具モデルの寸法・前方向きメタデータ（2D/3D共通の単一ソース）
  useEffect(() => {
    const fetchFurnitureMetadata = async () => {
      try {
        const res = await fetch('/models/furniture-metadata.json');
        if (!res.ok) return;
        const data = await res.json();
        if (data && typeof data === 'object') {
          setFurnitureMetadataMap(data as FurnitureModelMetadataMap);
        }
      } catch {
        // メタデータが無い場合は安全既定値で動作させる
      }
    };
    fetchFurnitureMetadata();
  }, []);

  // 2. Guarantee Selections in 3D Mode
  useEffect(() => {
    if (viewMode !== '3D') return;

    setSelections(prev => {
      const next = { ...prev };
      let changed = false;

      if (next['Sketch_Floor'] === undefined) {
        next['Sketch_Floor'] = null;
        changed = true;
      }
      
      if (next['Sketch_Ceiling'] === undefined) {
        next['Sketch_Ceiling'] = null;
        changed = true;
      }

      // Ensure walls are selected based on current points
      if (sketchPoints.length > 0) {
        for (let i = 0; i < sketchPoints.length; i++) {
            const key = `Sketch_Wall_${i}`;
            if (next[key] === undefined) {
                next[key] = null;
                changed = true;
            }
        }
      }

      return changed ? next : prev;
    });
  }, [viewMode, sketchPoints.length]);

  // Handle Delete Key for Furniture
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (activeFurnitureId) {
                setFurnitureItems(prev => prev.filter(item => item.id !== activeFurnitureId));
                setActiveFurnitureId(null);
            }
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFurnitureId]);

  // スケッチ外形変更時、家具を部屋内に収める
  useEffect(() => {
    if (sketchPoints.length < 3 || furnitureItems.length === 0) return;
    const { centerMm } = getRoomTransform(sketchPoints);
    const polygonMm = sketchPoints.map((p) => ({ x: scaledToMm(p.x), y: scaledToMm(p.y) }));
    setFurnitureItems((prev) => {
      const next = clampAllFurnitureToRoom(prev, centerMm, polygonMm);
      let changed = false;
      for (let i = 0; i < prev.length; i += 1) {
        const a = prev[i].position;
        const b = next[i].position;
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
          changed = true;
          break;
        }
      }
      return changed ? next : prev;
    });
  }, [sketchPoints]);

  // GLTF から家具足跡の基準寸法（未設定のアイテムのみ）
  useEffect(() => {
    // 2D軽量フローでは実行時計測を止める（フリーズ回避）
    if (viewMode === 'sketch') return;
    let cancelled = false;
    const cleanupTasks: Array<() => void> = [];
    const pending = furnitureItemsRef.current.filter((item) => {
      // API/Cloudinaryでfootprint2dがあるものは実測不要（重いBox3計測を回避）
      if (item.footprint2d || item.modelFootprintBaseMm || !item.modelUrl) return false;
      if (furnitureFootprintAttemptedRef.current.has(item.id)) return false;
      furnitureFootprintAttemptedRef.current.add(item.id);
      return true;
    });
    const runNext = () => {
      if (cancelled) return;
      const item = pending.shift();
      if (!item || !item.modelUrl) return;
      const modelUrl = item.modelUrl;
      const cancelTask = scheduleIdleTask(() => {
        if (cancelled) return;
        const t0 = performance.now();
        computeGltfFootprintBaseMm(modelUrl)
          .then((dims) => {
            if (cancelled) return;
            setFurnitureItems((prev) =>
              prev.map((f) => (f.id === item.id ? { ...f, modelFootprintBaseMm: dims } : f))
            );
          })
          .catch(() => {})
          .finally(() => {
            const elapsed = performance.now() - t0;
            if (PERF_TRACE && elapsed > PERF_THRESH_MS.footprint) {
              console.warn('[perf][footprint] slow scan', { elapsedMs: Math.round(elapsed), id: item.id, url: modelUrl });
            }
            if (LAMP_DEV_TRACE && /lamp|light/i.test(`${item.type ?? ''} ${item.name ?? ''} ${item.modelUrl ?? ''}`)) {
              console.info('[lamp-trace][footprint-scan]', {
                id: item.id,
                name: item.name,
                elapsedMs: Math.round(elapsed),
                url: modelUrl
              });
            }
            runNext();
          });
      }, 220);
      cleanupTasks.push(cancelTask);
    };

    runNext();
    return () => {
      cancelled = true;
      cleanupTasks.forEach((cancelTask) => cancelTask());
    };
  }, [furnitureItemsFootprintScanKey, viewMode]);

  // Auto-scroll side panel on mesh selection
  useEffect(() => {
    if (activeMeshes.length === 0) return;

    // Scroll Catalog based on first selected mesh
    const firstMesh = activeMeshes[0];
    const selectedProduct = selections[firstMesh];
    if (selectedProduct) {
        const card = document.getElementById(`product-card-${selectedProduct.id}`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    // Scroll Cost Table
    const costRow = document.getElementById(`cost-row-${firstMesh}`);
    if (costRow) {
        costRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeMeshes, selections]);

  // 3. Compute Available Brands
  const availableBrands = useMemo(() => {
    const brands = new Set(products.map(p => p.brand));
    return Array.from(brands).filter(Boolean).sort();
  }, [products]);

  // 4. Compute Available Categories
  const availableCategories = useMemo(() => {
    const cats = new Set<string>(products.map(p => p.category));
    const order = ['Floor', 'Wall', 'Ceiling', 'Furniture', 'Window'];
    return Array.from(cats).sort((a, b) => {
        const idxA = order.indexOf(a);
        const idxB = order.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
    });
  }, [products]);

  const handleMeshClick = (category: MaterialCategory, meshName: string, isMulti: boolean) => {
    if (isMulti) {
      setActiveMeshes(prev => prev.includes(meshName) ? prev.filter(m => m !== meshName) : [...prev, meshName]);
    } else {
      setActiveMeshes([meshName]);
    }
    setActiveCategory(category);
    // メッシュ選択時は家具・建具の選択をクリア（完全排他）
    setActiveFurnitureId(null);
    setSelectedOpeningId(null);
  };

  // 家具選択時に壁/床・建具の選択を解除するハンドラー（完全排他）
  const handleFurnitureSelect = (id: string | null) => {
    setActiveFurnitureId(id);
    if (id) {
      setActiveMeshes([]);
      setActiveCategory(null);
      setSelectedOpeningId(null);
    }
  };

  // 建具選択時に他の選択を解除するハンドラー（完全排他）
  const handleOpeningSelect = (id: string | null) => {
    setSelectedOpeningId(id);
    if (id) {
      setActiveMeshes([]);
      setActiveCategory(null);
      setActiveFurnitureId(null);
    }
  };

  const handleMaterialUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target) return;
    // Explicitly cast to File[] to avoid 'unknown' type errors on file properties
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;

    files.forEach(file => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          const newProduct: Product = {
            id: `custom-${Date.now()}-${Math.random()}`,
            name: file.name.split('.')[0],
            brand: 'Custom',
            category: activeCategory || 'Wall',
            pricePerUnit: 0,
            unit: '㎡',
            lossFactor: 0,
            textureUrl: reader.result as string,
            color: '#ffffff',
            pbr: { roughness: 0.8, metalness: 0, reflectivity: 0, glossiness: 'Matte', normalMapStrength: 0 },
            promptHint: '(Custom Texture)'
          };
          
          setProducts(prev => [newProduct, ...prev]);
          
          // Apply to all selected meshes
          if (activeMeshes.length > 0) {
            setSelections(prev => {
                const next = { ...prev };
                activeMeshes.forEach(meshName => {
                    next[meshName] = newProduct;
                });
                return next;
            });
          }
        }
      };
      reader.readAsDataURL(file);
    });
    
    if (e.target) e.target.value = '';
  };

  const handleProductSelect = (product: Product) => {
    if (activeMeshes.length === 0) return;
    setSelections(prev => {
        const next = { ...prev };
        activeMeshes.forEach(meshName => {
            next[meshName] = product;
        });
        return next;
    });
  };

  // 平面図/天伏図の表示モード（SketchCanvas と共有）。天伏図での家具配置は天井オブジェクト扱い。
  const [isCeilingView, setIsCeilingView] = useState(false);

  const handleAddFurniture = (catalogItem: FurnitureCatalogItem) => {
      const id = `furniture-${Date.now()}`;
      const meta = resolveFurnitureMetadata(catalogItem);
      if (META_SOURCE_TRACE) {
        console.info('[furniture-meta-source]', {
          id,
          name: catalogItem.name,
          url: catalogItem.url,
          source: meta.source,
          widthMm: meta.widthMm,
          depthMm: meta.depthMm
        });
      }
      if (LAMP_DEV_TRACE && /lamp|light/i.test(`${catalogItem.type ?? ''} ${catalogItem.name ?? ''}`)) {
        console.info('[lamp-trace][add]', {
          id,
          name: catalogItem.name,
          type: catalogItem.type,
          source: meta.source,
          footprint: { widthMm: meta.widthMm, depthMm: meta.depthMm }
        });
      }
      const initialYaw = degToRad(meta.forwardYawDeg ?? 0);
      const defaultScale = Number.isFinite(catalogItem.defaultScale) ? Number(catalogItem.defaultScale) : 1;
      const defaultY = Number.isFinite(catalogItem.defaultY) ? Number(catalogItem.defaultY) : 0;
      // 天伏図で配置した家具は天井オブジェクト（ceilingMount）として扱い、天井高さに配置する。
      const placeOnCeiling = isCeilingView;
      const newItem: FurnitureItem = {
          id,
          type: catalogItem.type,
          name: catalogItem.name,
          modelUrl: catalogItem.url,
          position: [0, placeOnCeiling ? roomHeight / 1000 : defaultY, 0],
          rotation: [0, initialYaw, 0],
          scale: [defaultScale, defaultScale, defaultScale],
          footprint2d: {
            width: Number.isFinite(meta.widthMm ?? NaN) ? (meta.widthMm as number) : 1000,
            depth: Number.isFinite(meta.depthMm ?? NaN) ? (meta.depthMm as number) : 700
          },
          modelForwardYawDeg: meta.forwardYawDeg ?? 0,
          ceilingMount: placeOnCeiling
      };
      setFurnitureItems(prev => [...prev, newItem]);
      setActiveFurnitureId(id);
      setToolMode('add');
      setAddKind('furniture');
      setSelectedOpeningId(null);
      setActiveMeshes([]);
      setActiveCategory(null);
  };

  /** 2D キャンバスの点を sketchPoints（3D 用）へ反映。生成ボタン／3D トグルの両方から使う */
  const commitSketchPointsToRoomState = useCallback((points: SketchPoint[]) => {
    setSketchPoints(points);
    setSelections(prev => {
      const next = { ...prev };
      if (next['Sketch_Floor'] === undefined) next['Sketch_Floor'] = null;
      if (next['Sketch_Ceiling'] === undefined) next['Sketch_Ceiling'] = null;
      for (let i = 0; i < points.length; i++) {
        if (next[`Sketch_Wall_${i}`] === undefined) next[`Sketch_Wall_${i}`] = null;
      }
      return next;
    });
  }, []);

  const handleSketchApply = (points: SketchPoint[]) => {
    commitSketchPointsToRoomState(points);
    setViewMode('3D');
  };

  /** ヘッダー「3Dビュー」: 2D で編集した内容を pending からコミットしてから切り替え */
  const handleSwitchTo3DView = useCallback(() => {
    const pts = pendingPoints.length >= 3 ? pendingPoints : sketchPoints;
    if (pts.length >= 3) commitSketchPointsToRoomState(pts);
    setViewMode('3D');
  }, [pendingPoints, sketchPoints, commitSketchPointsToRoomState]);
  const canNavigateTo3D = pendingPoints.length >= 3 || sketchPoints.length >= 3;
  const navigateToSketch = useCallback(() => {
    setAiEditOpen(false);
    startTransition(() => setViewMode('sketch'));
  }, []);
  const navigateTo3D = useCallback(() => {
    setAiEditOpen(false);
    handleSwitchTo3DView();
  }, [handleSwitchTo3DView]);
  const navigateToAiEdit = useCallback(() => {
    setAiEditOpen(true);
  }, []);

  const renderGlobalModeToggle = (active: 'sketch' | '3D' | 'ai') => (
    <ModeToggleBar
      activeMode={active}
      onSwitchToSketch={navigateToSketch}
      onSwitchTo3D={navigateTo3D}
      onSwitchToAi={navigateToAiEdit}
      canSwitchTo3D={canNavigateTo3D}
      canSwitchToAi={!!renderState.resultImageUrl}
      aiDisabledTitle="AIレンダリング完了後に利用できます"
    />
  );

  const calculateArea = (points: SketchPoint[]) => {
    if (points.length < 3) return 0;
    let area = 0;
    const scale = 0.05; 
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      area += (points[i].x / scale) * (points[j].y / scale);
      area -= (points[i].y / scale) * (points[j].x / scale); 
    }
    return Math.abs(area) / 2 / 1000000;
  };

  const getRoomBoundsMm = useCallback(() => {
    if (sketchPoints.length < 2) return null;
    const xs = sketchPoints.map((p) => scaledToMm(p.x));
    const ys = sketchPoints.map((p) => scaledToMm(p.y));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      widthMm: Math.max(1, Math.round(maxX - minX)),
      depthMm: Math.max(1, Math.round(maxY - minY)),
    };
  }, [sketchPoints]);

  const costBreakdown = useMemo(() => {
    const floorArea = calculateArea(sketchPoints);
    const results: any[] = [];
    const structuralMeshes = ['Sketch_Floor', 'Sketch_Ceiling'];
    if (sketchPoints.length >= 3) {
      sketchPoints.forEach((_, i) => structuralMeshes.push(`Sketch_Wall_${i}`));
    }
    Object.keys(selections).forEach(key => {
        if (!structuralMeshes.includes(key)) structuralMeshes.push(key);
    });

    structuralMeshes.forEach(meshName => {
        const prod = selections[meshName];
        if (!prod) return; 

        let area = 0;
        if (meshName === 'Sketch_Floor' || meshName === 'Sketch_Ceiling') {
            area = floorArea;
        } else if (meshName.startsWith('Sketch_Wall_')) {
            const parts = meshName.replace('Sketch_Wall_', '').split('_');
            const baseIdx = parseInt(parts[0], 10);
            const nextPt = sketchPoints[(baseIdx + 1) % sketchPoints.length];
            
            if (sketchPoints[baseIdx] && nextPt) {
                const distMm = Math.hypot(sketchPoints[baseIdx].x - nextPt.x, sketchPoints[baseIdx].y - nextPt.y) / 0.05;
                const divs = wallDivisions[baseIdx] || 1;
                let segBottomMm = 0;
                let segTopMm = roomHeight;
                let grossArea = 0;

                if (divs === 1) {
                    grossArea = (distMm * roomHeight) / 1000000;
                    segBottomMm = 0;
                    segTopMm = roomHeight;
                } else {
                    const subIdx = parseInt(parts[1], 10);
                    const bottomProd = selections[`Sketch_Wall_${baseIdx}_0`];
                    const bottomProdId = bottomProd ? bottomProd.id : 'default_no_tex';
                    const bottomHeight = materialSettings[bottomProdId]?.wainscotHeight ?? 900;
                    const segHeight = subIdx === 0 ? bottomHeight : Math.max(0, roomHeight - bottomHeight);
                    grossArea = (distMm * segHeight) / 1000000;
                    if (subIdx === 0) {
                        segBottomMm = 0;
                        segTopMm = bottomHeight;
                    } else {
                        segBottomMm = bottomHeight;
                        segTopMm = roomHeight;
                    }
                }

                let holeSum = 0;
                for (const op of openings) {
                    if (op.wallIndex !== baseIdx) continue;
                    holeSum += openingHoleAreaM2OnWallSegment(op, segBottomMm, segTopMm);
                }
                area = Math.max(0, grossArea - holeSum);
            }
        }

        if (area > 0 || (area === 0 && !meshName.startsWith('Sketch_'))) {
            results.push({ 
                meshName, 
                unitPrice: materialUnitPriceOverrides[prod.id] ?? prod.pricePerUnit,
                lossFactor: prod.lossFactor,
                cost: (materialUnitPriceOverrides[prod.id] ?? prod.pricePerUnit) * area * (1 + prod.lossFactor), 
                area, 
                prodName: prod.name, 
                brand: prod.brand, 
                textureUrl: prod.textureUrl,
                productId: prod.id,
            });
        }
    });

    return results.sort((a, b) => {
        const getScore = (name: string) => {
            if (name === 'Sketch_Floor') return 1;
            if (name.startsWith('Sketch_Wall')) return 2;
            if (name === 'Sketch_Ceiling') return 3;
            return 4;
        };
        const scoreA = getScore(a.meshName);
        const scoreB = getScore(b.meshName);
        if (scoreA !== scoreB) return scoreA - scoreB;
        if (a.meshName.startsWith('Sketch_Wall') && b.meshName.startsWith('Sketch_Wall')) {
             return parseInt(a.meshName.replace('Sketch_Wall_', '')) - parseInt(b.meshName.replace('Sketch_Wall_', ''));
        }
        return a.meshName.localeCompare(b.meshName);
    });
  }, [selections, sketchPoints, roomHeight, products, wallDivisions, openings, materialSettings, materialUnitPriceOverrides]);

  const materialsTotal = useMemo(
    () => costBreakdown.reduce((sum, item) => sum + item.cost, 0),
    [costBreakdown]
  );
  const furnitureTotal = useMemo(
    () => furnitureItems.reduce((sum, item) => sum + (item.customPrice ?? 0), 0),
    [furnitureItems]
  );
  const aiEstimateTotal = useMemo(
    () => aiEstimateItems.reduce((sum, item) => sum + (item.price ?? 0), 0),
    [aiEstimateItems]
  );
  const grandTotal = useMemo(
    () => materialsTotal + furnitureTotal + aiEstimateTotal,
    [materialsTotal, furnitureTotal, aiEstimateTotal]
  );
  const furnitureMissingCount = useMemo(
    () => furnitureItems.filter((item) => !(item.customPrice && item.customPrice > 0)).length,
    [furnitureItems]
  );
  const aiEstimateMissingCount = useMemo(
    () =>
      aiEstimateItems.filter(
        (item) => !item.name.trim() || !item.brand.trim() || !(item.price && item.price > 0)
      ).length,
    [aiEstimateItems]
  );
  const missingInputCount = furnitureMissingCount + aiEstimateMissingCount;

  const estimatePayload = useMemo(
    () =>
      buildEstimateExportPayload(costBreakdown as CostBreakdownEntry[], furnitureItems, aiEstimateItems, {
        wallDivisions,
      }),
    [costBreakdown, furnitureItems, aiEstimateItems, wallDivisions]
  );
  const canExportEstimate =
    estimatePayload.materialSections.some((s) => s.rows.length > 0) ||
    estimatePayload.furniture.length > 0 ||
    estimatePayload.aiItems.length > 0;

  const [estimateExportBusy, setEstimateExportBusy] = useState(false);

  const executeEstimateExport = useCallback(async (kind: 'pdf' | 'csv') => {
    if (!canExportEstimate || estimateExportBusy) return;
    setEstimateExportBusy(true);
    try {
      if (kind === 'pdf') {
        await downloadEstimatePdf(estimatePayload);
      } else {
        downloadEstimateCsv(estimatePayload);
      }
    } finally {
      setEstimateExportBusy(false);
    }
  }, [canExportEstimate, estimateExportBusy, estimatePayload]);

  const handleExportEstimateCsv = useCallback(() => {
    if (!canExportEstimate) return;
    if (missingInputCount > 0) {
      setPendingExportKind('csv');
      setEstimateGuardOpen(true);
      return;
    }
    void executeEstimateExport('csv');
  }, [canExportEstimate, executeEstimateExport, missingInputCount]);

  const handleExportEstimatePdf = useCallback(async () => {
    if (!canExportEstimate) return;
    if (missingInputCount > 0) {
      setPendingExportKind('pdf');
      setEstimateGuardOpen(true);
      return;
    }
    await executeEstimateExport('pdf');
  }, [canExportEstimate, executeEstimateExport, missingInputCount]);

  const handleEstimateExportSelect = useCallback((kind: 'pdf' | 'csv') => {
    setEstimateDownloadMenuOpen(false);
    if (kind === 'pdf') {
      void handleExportEstimatePdf();
      return;
    }
    handleExportEstimateCsv();
  }, [handleExportEstimateCsv, handleExportEstimatePdf]);

  const filteredProducts = useMemo(() => {
    let items = products;
    if (activeCategory) items = items.filter(p => p.category === activeCategory);
    if (selectedBrand) items = items.filter(p => p.brand === selectedBrand);

    if (sortOrder === 'price-asc') items = [...items].sort((a, b) => a.pricePerUnit - b.pricePerUnit);
    else if (sortOrder === 'price-desc') items = [...items].sort((a, b) => b.pricePerUnit - a.pricePerUnit);
    else if (sortOrder === 'name-asc') items = [...items].sort((a, b) => a.name.localeCompare(b.name));
    
    return items;
  }, [activeCategory, selectedBrand, products, sortOrder]);

  const handleAddAiEstimateItem = useCallback(() => {
    setAiEstimateItems((prev) => [...prev, createAiEstimateItem()]);
  }, []);

  const handleUpdateAiEstimateItem = useCallback(
    (id: string, patch: Partial<AiEstimateItem>) => {
      setAiEstimateItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    },
    []
  );

  const handleRemoveAiEstimateItem = useCallback((id: string) => {
    setAiEstimateItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const renderEstimatePanel = useCallback(
    (forAiEdit = false) => {
      const aggregatedMaterials = Array.from(
        costBreakdown.reduce((map, item: any) => {
          const key = item.productId || `${item.brand}|${item.prodName}|${item.textureUrl ?? ''}`;
          if (map.has(key)) {
            const existing = map.get(key);
            existing.area += item.area;
            existing.cost += item.cost;
            existing.meshNames.push(item.meshName);
          } else {
            map.set(key, { ...item, meshNames: [item.meshName] });
          }
          return map;
        }, new Map()).values()
      );

      return (
        <div
          className={`relative z-20 mb-2 pointer-events-auto border-b ${showCostPanel ? 'border-white/10 bg-[#080808]' : 'border-emerald-300/25 bg-[#0b0b0b]'} shadow-[0_10px_30px_rgba(0,0,0,0.35)] transition-[height] duration-500 ease-in-out contain-layout ${
            showCostPanel ? 'grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]' : 'shrink-0'
          }`}
        >
          <div className={`shrink-0 px-3 py-2 ${showCostPanel ? 'border-b border-white/5' : 'border-b border-emerald-300/20 bg-emerald-300/5'}`}>
            {/* 上段: 入力判定 + DL（3D / AI 共通・横並び） */}
            <div className="flex min-w-0 flex-row items-center justify-between gap-2">
              <div className="min-w-0 shrink">
                {missingInputCount > 0 ? (
                  <div className="inline-flex max-w-full rounded-lg border border-amber-400/60 bg-amber-300/20 px-2.5 py-1.5 text-[10px] font-black tracking-wide text-amber-100 sm:px-3 sm:text-[11px]">
                    <span className="truncate">未入力 {missingInputCount}件</span>
                  </div>
                ) : (
                  <div className="inline-flex rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-1.5 text-[10px] font-black tracking-wide text-emerald-200 sm:px-3 sm:text-[11px]">
                    入力状態: 完了
                  </div>
                )}
              </div>
              <div className="relative shrink-0" ref={estimateDownloadMenuRef}>
                <button
                  type="button"
                  disabled={!canExportEstimate || estimateExportBusy}
                  title="概算見積をダウンロード"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEstimateDownloadMenuOpen((open) => !open);
                  }}
                  className="inline-flex max-w-[min(240px,55vw)] items-center justify-center gap-1.5 rounded-lg border border-emerald-500/55 bg-emerald-500/20 px-2 py-1.5 text-[10px] font-black tracking-wide text-emerald-50 transition-colors hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-35 sm:max-w-none sm:px-3 sm:py-2 sm:text-[11px]"
                >
                  <Download className="h-3.5 w-3.5 shrink-0" />
                  <span className="max-w-[11rem] truncate text-center leading-tight sm:max-w-none sm:whitespace-normal">
                    {estimateExportBusy ? '出力中…' : '概算見積をダウンロード'}
                  </span>
                </button>
                {estimateDownloadMenuOpen && !estimateExportBusy && canExportEstimate && (
                  <div
                    className="absolute right-0 top-full z-30 mt-2 min-w-[220px] rounded-xl border border-white/15 bg-[#111] p-1.5 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => handleEstimateExportSelect('pdf')}
                      className="w-full rounded-lg px-3 py-2 text-left text-[11px] font-black tracking-wide text-neutral-100 transition-colors hover:bg-white/10"
                    >
                      PDFでダウンロード
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEstimateExportSelect('csv')}
                      className="mt-1 w-full rounded-lg px-3 py-2 text-left text-[11px] font-black tracking-wide text-neutral-100 transition-colors hover:bg-white/10"
                    >
                      CSVでダウンロード
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* 下段: 合計金額 + 明細の開閉 */}
            <button
              type="button"
              onClick={() => {
                setEstimateDownloadMenuOpen(false);
                setShowCostPanel(!showCostPanel);
              }}
              className={`mt-2 flex w-full min-w-0 items-center justify-between gap-2 rounded-xl px-2 py-2 text-left transition-colors ${showCostPanel ? 'hover:bg-white/5' : 'bg-white/[0.03] hover:bg-white/10'}`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-lg transition-colors duration-300 ease-in-out ${showCostPanel ? 'bg-emerald-500 text-black' : 'bg-emerald-400/30 text-emerald-100 ring-1 ring-emerald-300/45'}`}
                >
                  <span className="font-mono text-lg font-black">¥</span>
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-black uppercase tracking-widest text-neutral-400">合計金額</div>
                  <div className="font-mono text-2xl font-black leading-none tracking-tight text-white">
                    {Math.round(grandTotal).toLocaleString()}
                  </div>
                </div>
              </div>
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-[transform,colors,box-shadow] duration-500 ease-in-out ${showCostPanel ? 'rotate-180 border-white/15 bg-white/10' : 'border-emerald-300/45 bg-emerald-300/15 shadow-[0_0_0_1px_rgba(16,185,129,0.2)]'}`}
              >
                <svg
                  className={`h-4 w-4 ${showCostPanel ? 'text-neutral-300' : 'text-emerald-100'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 15l7-7 7 7" />
                </svg>
              </div>
            </button>
          </div>

          {showCostPanel ? (
            <div className="min-h-0 min-w-0 overflow-y-auto px-4 pb-4 pt-2 opacity-100 md:px-5 md:pb-6 xl:px-6 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent transition-opacity duration-500 ease-in-out">
              <EstimatePanelDetailScroll
                forAiEdit={forAiEdit}
                aggregatedMaterials={aggregatedMaterials}
                materialsTotal={materialsTotal}
                activeMeshes={activeMeshes}
                materialUnitPriceOverrides={materialUnitPriceOverrides}
                setMaterialUnitPriceOverrides={setMaterialUnitPriceOverrides}
                furnitureItems={furnitureItems}
                activeFurnitureId={activeFurnitureId}
                setFurnitureItems={setFurnitureItems}
                furnitureTotal={furnitureTotal}
                aiEstimateItems={aiEstimateItems}
                aiEstimateTotal={aiEstimateTotal}
                handleAddAiEstimateItem={handleAddAiEstimateItem}
                handleUpdateAiEstimateItem={handleUpdateAiEstimateItem}
                handleRemoveAiEstimateItem={handleRemoveAiEstimateItem}
                furnitureEstimateSectionRef={furnitureEstimateSectionRef}
                aiEstimateSectionRef={aiEstimateSectionRef}
              />
            </div>
          ) : null}
        </div>
      );
    },
    [
      activeFurnitureId,
      activeMeshes,
      aiEstimateItems,
      aiEstimateTotal,
      canExportEstimate,
      costBreakdown,
      estimateExportBusy,
      furnitureItems,
      furnitureTotal,
      grandTotal,
      handleAddAiEstimateItem,
      handleEstimateExportSelect,
      handleRemoveAiEstimateItem,
      handleUpdateAiEstimateItem,
      materialUnitPriceOverrides,
      materialsTotal,
      missingInputCount,
      showCostPanel,
      setFurnitureItems,
      estimateDownloadMenuOpen,
    ]
  );

  const handleGuardContinueExport = useCallback(() => {
    if (!pendingExportKind) return;
    const nextKind = pendingExportKind;
    setEstimateGuardOpen(false);
    setPendingExportKind(null);
    void executeEstimateExport(nextKind);
  }, [executeEstimateExport, pendingExportKind]);

  const focusFurnitureInputs = useCallback(() => {
    setEstimateGuardOpen(false);
    setPendingExportKind(null);
    setShowCostPanel(true);
    furnitureEstimateSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const focusAiInputs = useCallback(() => {
    setEstimateGuardOpen(false);
    setPendingExportKind(null);
    setShowCostPanel(true);
    aiEstimateSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  return (
    <div className="flex h-screen w-screen bg-[#050505] text-neutral-100 overflow-hidden font-sans select-none relative">
      {/* サムネイル自動生成＆保存キュー */}
      <ThumbnailGeneratorQueue
        enabled={(viewMode === '3D' || generationQueue.length > 0) && cacheTrigger >= 0}
      />

      <input 
        type="file" 
        id="file-upload" 
        name="file-upload"
        ref={fileInputRef} 
        className="hidden" 
        accept=".glb,.gltf" 
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) { setCustomModelUrl(URL.createObjectURL(file)); setViewMode('3D'); }
        }} 
      />

      {/* 画面全体のローディング表示（デノイズ中） */}
      {isDenoising && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 text-white font-bold text-xl">
              AIでノイズを除去して下絵をクリーンアップ中...
          </div>
      )}



      {/* Main Content Area (Full Screen Workspace) */}
      <div className="flex-1 relative flex flex-col min-w-0 z-10 bg-[#050505]">
          
          {/* View Area */}
          <div
            className={`flex-1 relative flex justify-center overflow-hidden bg-black/50 ${
              viewMode === '3D' ? 'items-end p-0' : 'items-center p-4 lg:p-8'
            }`}
          >
             {!renderState.isRendering && (viewMode === 'sketch' || viewMode === '3D') && (
                <div className="absolute top-6 left-6 right-6 z-50 flex items-start justify-between gap-3 pointer-events-none">
                    {renderGlobalModeToggle(aiEditOpen ? 'ai' : viewMode)}
                    {viewMode === '3D' && (
                      <div className="flex items-start justify-end gap-2 flex-wrap">
                        <div className="glass p-1.5 rounded-2xl border border-white/10 flex items-center gap-2 bg-black/40 backdrop-blur-md shadow-xl pointer-events-auto shrink-0 h-[46px]">
                          <span className="text-[10px] font-black uppercase text-neutral-400 tracking-widest">天井高</span>
                          <div className="flex items-center gap-1.5">
                            <NumericField
                              value={roomHeight}
                              onChange={setRoomHeight}
                              dragSensitivity={10}
                              className="w-[76px]"
                              inputClassName="text-center text-emerald-400"
                            />
                            <span className="text-[9px] text-neutral-500 font-bold uppercase">mm</span>
                          </div>
                        </div>
                        <div className="glass p-1.5 rounded-2xl border border-white/10 flex items-center shadow-xl bg-black/40 backdrop-blur-md pointer-events-auto shrink-0 h-[46px]">
                          {([
                            { id: 'day', label: '昼' },
                            { id: 'evening', label: '夕方' },
                            { id: 'night', label: '夜' },
                          ] as const).map((preset) => (
                            <button
                              key={preset.id}
                              onClick={() => setOutsideBackgroundPreset(preset.id)}
                              className={`h-[34px] px-3.5 rounded-xl text-[11px] font-black tracking-widest transition-all ${
                                outsideBackgroundPreset === preset.id
                                  ? 'bg-white text-black'
                                  : 'text-white/60 hover:text-white'
                              }`}
                              title="窓越し背景"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                        <div className="glass p-1.5 rounded-2xl border border-white/10 flex items-center shadow-xl bg-black/40 backdrop-blur-md pointer-events-auto shrink-0 h-[46px]">
                          <button
                            onClick={() => setSkeletonCeiling((v) => !v)}
                            className={`h-[34px] px-3.5 rounded-xl text-[11px] font-black tracking-widest transition-all ${
                              skeletonCeiling ? 'bg-amber-500 text-black' : 'text-white/60 hover:text-white'
                            }`}
                            title="スケルトン天井: 天井スラブを外して梁などの上部構造を表示"
                          >
                            スケルトン天井
                          </button>
                        </div>
                      </div>
                    )}
                </div>
             )}

             {!renderState.isRendering && viewMode === '3D' && (
               <div className="absolute top-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
                 <button
                   onClick={handleInstantRender}
                   disabled={renderState.isRendering}
                   className="pointer-events-auto flex items-center justify-center gap-2 px-8 py-3 rounded-2xl bg-purple-900/75 border border-purple-500/30 text-purple-100 shadow-[0_8px_24px_rgba(76,29,149,0.35)] hover:bg-purple-800/80 transition-all disabled:opacity-60"
                 >
                   <Sparkles className="w-4 h-4 shrink-0" />
                   <span className="text-[11px] font-black uppercase tracking-widest">AIレンダリング</span>
                 </button>
               </div>
             )}
             
             {viewMode === 'sketch' && (
                <div className="absolute inset-0 z-10 w-full h-full">
                     <SketchCanvas 
                        initialPoints={sketchPoints} 
                        gridSize={gridSnapSize} 
                        lengthSnapSize={lengthSnapSize} 
                        isLengthSnapEnabled={isLengthSnapEnabled} 
                        angleSnap={angleSnapSize} 
                        isAngleSnapEnabled={isAngleSnapEnabled} 
                        onGridSizeChange={setGridSnapSize} 
                        onLengthSnapSizeChange={setLengthSnapSize} 
                        onLengthSnapToggle={setIsLengthSnapEnabled} 
                        onAngleSnapChange={setAngleSnapSize} 
                        onAngleSnapToggle={setIsAngleSnapEnabled} 
                        onSketchUpdate={(pts, closed) => { setPendingPoints(pts); setIsClosedPending(closed); }} 
                        onApply={handleSketchApply} 
                        openings={openings}
                        setOpenings={setOpenings}
                        selectedOpeningId={selectedOpeningId}
                        onOpeningSelect={handleOpeningSelect}
                        toolMode={toolMode}
                        setToolMode={setToolMode}
                        addKind={addKind}
                        setAddKind={setAddKind}
                        furnitureItems={furnitureItems}
                        onFurnitureUpdate={setFurnitureItems}
                        activeFurnitureId={activeFurnitureId}
                        onFurnitureSelect={handleFurnitureSelect}
                        underlay={underlay}
                        onUnderlayChange={(u) => useProjectStore.getState().setUnderlay(u)}
                        beams={beams}
                        onBeamsChange={(b) => useProjectStore.getState().setBeams(b)}
                        isCeilingView={isCeilingView}
                        onCeilingViewChange={setIsCeilingView}
                     />
                     
                     {!renderState.isRendering && (
                        <div className="absolute bottom-6 right-6 z-40 pointer-events-auto">
                            <FurnitureAssetStrip
                                processedCatalog={processedCatalog}
                                assetCategories={assetCategories}
                                selectedAssetCategory={selectedAssetCategory}
                                onSelectedAssetCategoryChange={setSelectedAssetCategory}
                                onPickItem={handleAddFurniture}
                                renderThumbnail={(item) => <ModelThumbnail url={item.url} name={item.name} />}
                                fetchStatus={furnitureCatalogFetchStatus}
                                fetchErrorMessage={furnitureCatalogErrorText}
                            />
                        </div>
                     )}
                </div>
             )}

             {viewMode === '3D' && (
                // 16:9 (aspect-video) に強制固定し、はみ出ないように最大化するコンテナ
                <div className="relative w-full aspect-video overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.5)] ring-1 ring-white/10 bg-[#0a0a0a]">
                     <RoomViewer 
                        selections={selections as any} 
                        onMeshClick={handleMeshClick} 
                        activeCategory={activeCategory} 
                        activeMeshes={activeMeshes} 
                        cameraRef={cameraRef} 
                        modelUrl={customModelUrl} 
                        sketchPoints={sketchPoints} 
                        roomHeight={roomHeight / 1000}
                        skeletonCeiling={skeletonCeiling}
                        snapshotMode={snapshotMode} 
                        furnitureItems={furnitureItems}
                        onFurnitureUpdate={setFurnitureItemsFrom3D}
                        beams={beams}
                        activeFurnitureId={activeFurnitureId}
                        onFurnitureSelect={handleFurnitureSelect} 
                        hideFurniture={hideFurniture}
                        maskMode={maskMode}
                        materialSettings={materialSettings}
                        wallDivisions={wallDivisions}
                        isRendering={renderState.isRendering}
                        captureStep={captureStep}
                        openings={openings}
                        setOpenings={setOpenings}
                        selectedOpeningId={selectedOpeningId}
                        onOpeningSelect={handleOpeningSelect}
                        outsideBackgroundColor={
                          outsideBackgroundPreset === 'day'
                            ? '#b8d8ff'
                            : outsideBackgroundPreset === 'evening'
                            ? '#f2b27a'
                            : '#1a2238'
                        }
                        orbitControlsRef={orbitControlsRef}
                        cameraBlendRequest={cameraBlendRequest}
                        onCameraBlendComplete={handleCameraBlendComplete}
                        cameraMode={cameraMode}
                        cameraFov={cameraFov}
                        eyeHeightMm={eyeHeightMm}
                        walkSessionKey={walkSessionKey}
                        walkInitialYaw={walkInitialYaw}
                        walkInitialPitch={walkInitialPitch}
                        walkSpawnXZ={walkSpawnXZ}
                        walkDigitalInputRef={walkDigitalInputRef}
                        cameraWalkStateRef={cameraWalkStateRef}
                    />

                    {/* --- フローティングUIを16:9のキャンバス「内部」に配置 --- */}
                    <>
                    {/* Right Side: Material / Opening / 家具の基本情報 */}
                    <div className="absolute inset-0 z-50 pointer-events-none">
                    {(() => {
                        const hasAnySelection = activeMeshes.length > 0 || !!selectedOpeningId || !!activeFurnitureId;
                        // 選択されたメッシュを適用中のProduct単位でグループ化
                        const groups = new Map<string, { product: any, area: number, cost: number, meshes: string[] }>();
                        activeMeshes.forEach(meshName => {
                            const prod = selections[meshName];
                            const prodId = prod ? prod.id : 'default_no_tex';
                            const costItem = costBreakdown.find(c => c.meshName === meshName);
                            const area = costItem?.area || 0;
                            const cost = costItem?.cost || 0;
                            if (groups.has(prodId)) {
                                const g = groups.get(prodId)!;
                                g.area += area;
                                g.cost += cost;
                                g.meshes.push(meshName);
                            } else {
                                groups.set(prodId, { product: prod, area, cost, meshes: [meshName] });
                            }
                        });

                        const totalWallMeshes = activeMeshes.filter(m => m.includes('Wall'));
                        const totalSelectedWallBaseIndices = Array.from(new Set(totalWallMeshes.map(m => parseInt(m.match(/^Sketch_Wall_(\d+)/)?.[1] || '-1')))).filter(id => id !== -1);
                        const isSingleWallSelectedOverall = totalSelectedWallBaseIndices.length === 1;

                        // 選択中の建具（ドア/窓）
                        const activeOpening = selectedOpeningId ? openings.find(o => o.id === selectedOpeningId) : null;
                        const propertyPanelWidthClass = 'w-[min(30vw,380px)] min-w-[min(260px,88vw)]';
                        const propertyCardBaseClass = 'glass rounded-2xl border border-white/10 bg-black/40 backdrop-blur-md shadow-xl shrink-0 min-w-[min(248px,86vw)]';

                        const handleDivisionChange = (divs: number, baseIdx: number) => {
                            setWallDivisions(prev => {
                                const next = { ...prev };
                                if (divs === 1) delete next[baseIdx];
                                else if (divs === 2) next[baseIdx] = 2;
                                return next;
                            });
                            setSelections(prev => {
                                const next = { ...prev };
                                const existingProd = next[`Sketch_Wall_${baseIdx}`] || next[`Sketch_Wall_${baseIdx}_0`];
                                if (divs === 1) {
                                    next[`Sketch_Wall_${baseIdx}`] = existingProd || null;
                                    delete next[`Sketch_Wall_${baseIdx}_0`]; delete next[`Sketch_Wall_${baseIdx}_1`];
                                } else {
                                    if (next[`Sketch_Wall_${baseIdx}_0`] === undefined) next[`Sketch_Wall_${baseIdx}_0`] = existingProd || null;
                                    if (next[`Sketch_Wall_${baseIdx}_1`] === undefined) next[`Sketch_Wall_${baseIdx}_1`] = existingProd || null;
                                    delete next[`Sketch_Wall_${baseIdx}`];
                                }
                                return next;
                            });
                            setActiveMeshes(prev => {
                                let nextMeshes = new Set<string>(prev);
                                if (divs === 1) {
                                    nextMeshes.delete(`Sketch_Wall_${baseIdx}_0`); nextMeshes.delete(`Sketch_Wall_${baseIdx}_1`);
                                    nextMeshes.add(`Sketch_Wall_${baseIdx}`);
                                } else {
                                    nextMeshes.delete(`Sketch_Wall_${baseIdx}`);
                                    nextMeshes.add(`Sketch_Wall_${baseIdx}_0`); nextMeshes.add(`Sketch_Wall_${baseIdx}_1`);
                                }
                                return Array.from(nextMeshes);
                            });
                        };

                        return (
                            <div className={`absolute top-6 right-6 ${propertyPanelWidthClass} flex flex-col gap-3 pointer-events-auto max-h-[75vh] overflow-y-auto pr-1 pb-2 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent`}>
                                {!hasAnySelection && (
                                    <div className={`${propertyCardBaseClass} px-4 py-4`}>
                                        <p className="text-[11px] font-black uppercase tracking-widest text-emerald-300">プロパティ</p>
                                        <p className="mt-2 text-[10px] text-neutral-300 font-semibold">
                                            面・家具・建具を選択すると、ここにテクスチャや寸法の編集パネルが表示されます。
                                        </p>
                                    </div>
                                )}
                                {Array.from(groups.entries()).map(([prodId, g], index) => {
                                    const settings = materialSettings[prodId] || {} as any;
                                    const bbEnabled = settings.baseboardEnabled ?? false;
                                    const bbHeight = settings.baseboardHeight ?? 60;
                                    const bbColor = settings.baseboardColor ?? '#ffffff';

                                    return (
                                        <div key={`${prodId}-${index}`} className={`${propertyCardBaseClass} px-4 py-3 flex flex-col gap-3 animate-in fade-in slide-in-from-top-4`}>
                                            {/* 上段・中段はそのまま維持してください（名前、面積、金額、ツヤ、金属感） */}
                                            <div className="flex items-center justify-between gap-2 w-full">
                                                <div className="flex flex-col min-w-0">
                                                    <span className="text-[10px] font-black uppercase text-emerald-400 tracking-widest truncate max-w-[140px]">{g.product?.name || 'ベースカラー (未設定)'}</span>
                                                    <span className="text-[8px] text-neutral-500 font-bold">{g.meshes.length} 面を選択中</span>
                                                </div>
                                                <div className="flex items-center gap-2 text-[10px] font-mono font-bold text-white bg-black/30 px-2 py-1 rounded-lg shrink-0">
                                                    <span>{g.area.toFixed(1)}㎡</span>
                                                    <span className="text-emerald-400">¥{Math.round(g.cost).toLocaleString()}</span>
                                                </div>
                                            </div>
                                            <div className="flex flex-col gap-2 w-full pt-2 border-t border-white/10">
                                                <div className="flex items-center gap-2 w-full min-w-0">
                                                    <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-9">ツヤ</span>
                                                    <input
                                                        type="range"
                                                        min={0}
                                                        max={1}
                                                        step={0.01}
                                                        value={1 - (settings.roughness ?? 0.5)}
                                                        onChange={(e) => {
                                                            const v = Number(e.target.value);
                                                            setMaterialSettings((prev) => ({
                                                                ...prev,
                                                                [prodId]: { ...prev[prodId], roughness: 1 - v },
                                                            }));
                                                        }}
                                                        className="flex-1 min-w-0 accent-emerald-500 h-1.5"
                                                    />
                                                    <span className="text-[9px] font-mono text-white/80 w-8 text-right tabular-nums shrink-0">
                                                        {(1 - (settings.roughness ?? 0.5)).toFixed(2)}
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-2 w-full min-w-0">
                                                    <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-9">金属感</span>
                                                    <input
                                                        type="range"
                                                        min={0}
                                                        max={1}
                                                        step={0.01}
                                                        value={settings.metalness ?? 0}
                                                        onChange={(e) => {
                                                            const v = Number(e.target.value);
                                                            setMaterialSettings((prev) => ({
                                                                ...prev,
                                                                [prodId]: { ...prev[prodId], metalness: v },
                                                            }));
                                                        }}
                                                        className="flex-1 min-w-0 accent-emerald-500 h-1.5"
                                                    />
                                                    <span className="text-[9px] font-mono text-white/80 w-8 text-right tabular-nums shrink-0">
                                                        {(settings.metalness ?? 0).toFixed(2)}
                                                    </span>
                                                </div>
                                            </div>
                                            {g.product?.textureUrl && (() => {
                                                const imageSize = textureImageSizes[prodId];
                                                const detectedShortEdgeMm = detectedTextureShortEdgeMmByProductId[prodId];
                                                const manualAppliedShortEdgeMm = settings.textureScale != null
                                                    ? Math.round(settings.textureScale * 1000)
                                                    : null;
                                                const autoTargetShortEdgeMm = 1000;
                                                const displayScale = detectedShortEdgeMm && detectedShortEdgeMm > 0
                                                    ? autoTargetShortEdgeMm / detectedShortEdgeMm
                                                    : 1;
                                                const autoAppliedShortEdgeMm = detectedShortEdgeMm && detectedShortEdgeMm > 0
                                                    ? Math.round(detectedShortEdgeMm * displayScale)
                                                    : autoTargetShortEdgeMm;
                                                const appliedShortEdgeMm = manualAppliedShortEdgeMm ?? autoAppliedShortEdgeMm;
                                                const isManualOverride = manualAppliedShortEdgeMm != null;
                                                const widthMm = imageSize
                                                    ? Math.round(appliedShortEdgeMm * (imageSize.width >= imageSize.height ? imageSize.width / imageSize.height : 1))
                                                    : appliedShortEdgeMm;
                                                const heightMm = imageSize
                                                    ? Math.round(appliedShortEdgeMm * (imageSize.height > imageSize.width ? imageSize.height / imageSize.width : 1))
                                                    : appliedShortEdgeMm;

                                                return (
                                                    <div className="flex items-center gap-3 w-full pt-3 border-t border-white/10">
                                                        <img
                                                            src={getThumbnailUrl(g.product.textureUrl)}
                                                            alt={g.product.name}
                                                            className="w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0"
                                                            onLoad={() => ensureOriginalTextureSize(prodId, g.product.textureUrl)}
                                                        />
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="text-[9px] text-neutral-300 font-bold">反映短辺（3D適用）</span>
                                                                <NumericField
                                                                    value={appliedShortEdgeMm}
                                                                    onChange={(mm) => {
                                                                        if (!Number.isFinite(mm)) return;
                                                                        const normalizedMm = Math.max(100, Math.round(mm));
                                                                        setMaterialSettings((prev) => ({
                                                                            ...prev,
                                                                            [prodId]: { ...prev[prodId], textureScale: normalizedMm / 1000 },
                                                                        }));
                                                                    }}
                                                                    dragSensitivity={5}
                                                                    className="w-24"
                                                                    inputClassName="text-[10px] text-right text-white"
                                                                />
                                                            </div>
                                                            <div className="mt-1 text-[9px] text-neutral-400 font-mono">
                                                                {imageSize
                                                                    ? `画像 ${imageSize.width}x${imageSize.height}px / 実寸 ${widthMm}x${heightMm}mm`
                                                                    : `元画像寸法を読み込み中... / 実寸 ${widthMm}x${heightMm}mm`}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })()}

                                            {/* 下段: 腰壁と巾木 */}
                                            {g.meshes.some(m => m.includes('Wall')) && (() => {
                                                const wallMeshes = g.meshes.filter(m => m.includes('Wall'));
                                                const selectedWallBaseIndices = Array.from(new Set(wallMeshes.map(m => parseInt(m.match(/^Sketch_Wall_(\d+)/)?.[1] || '-1')))).filter(id => id !== -1);
                                                
                                                const isSingleWallSurface = selectedWallBaseIndices.length === 1;
                                                const baseIdx = selectedWallBaseIndices[0];
                                                const currentDivs = baseIdx !== undefined ? (wallDivisions[baseIdx] || 1) : 1;

                                                const hasBottomSurface = wallMeshes.some(m => {
                                                    const match = m.match(/^Sketch_Wall_(\d+)(_(\d+))?$/);
                                                    return !match || !match[3] || parseInt(match[3]) === 0;
                                                });

                                                const isWainscotPart = g.meshes.some(m => m.match(/^Sketch_Wall_(\d+)_0$/) && wallDivisions[parseInt(m.match(/^Sketch_Wall_(\d+)/)![1])] === 2);

                                                return (
                                                    <div className="flex flex-col gap-3 w-full pt-3 border-t border-white/10">
                                                        {isSingleWallSelectedOverall && isSingleWallSurface && (
                                                            <div className="flex flex-col gap-2">
                                                                <label className="flex items-center gap-2 cursor-pointer group w-full">
                                                                    <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${currentDivs === 2 ? 'bg-emerald-500 border-emerald-500' : 'border-white/20 group-hover:border-white/40'}`}>
                                                                        {currentDivs === 2 && <svg className="w-3 h-3 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" /></svg>}
                                                                    </div>
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={currentDivs === 2}
                                                                        onChange={(e) => handleDivisionChange(e.target.checked ? 2 : 1, baseIdx)}
                                                                        className="hidden"
                                                                    />
                                                                    <span className="text-[10px] text-white font-bold tracking-widest">腰壁の有無</span>
                                                                </label>
                                                            </div>
                                                        )}

                                                        {isWainscotPart && (
                                                            <div className="flex items-center gap-2 mt-1 mb-2 min-w-0">
                                                                <span className="text-[8px] text-neutral-400 font-bold uppercase w-8 shrink-0">腰壁</span>
                                                                <NumericField
                                                                    value={settings.wainscotHeight ?? 900}
                                                                    onChange={(v) =>
                                                                        setMaterialSettings((prev) => ({
                                                                            ...prev,
                                                                            [prodId]: { ...prev[prodId], wainscotHeight: v },
                                                                        }))
                                                                    }
                                                                    dragSensitivity={5}
                                                                    className="flex-1 min-w-0"
                                                                    inputClassName="text-[10px] text-white text-right"
                                                                />
                                                                <span className="text-[9px] font-mono text-neutral-500 shrink-0">mm</span>
                                                            </div>
                                                        )}

                                                        {hasBottomSurface && (
                                                            <div className="flex items-center justify-between">
                                                                <label className="flex items-center gap-2 cursor-pointer group">
                                                                    <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${bbEnabled ? 'bg-emerald-500 border-emerald-500' : 'border-white/20 group-hover:border-white/40'}`}>
                                                                        {bbEnabled && <svg className="w-3 h-3 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" /></svg>}
                                                                    </div>
                                                                    <input type="checkbox" checked={bbEnabled} onChange={(e) => setMaterialSettings(prev => ({ ...prev, [prodId]: { ...prev[prodId], baseboardEnabled: e.target.checked } }))} className="hidden" />
                                                                    <span className="text-[10px] text-white font-bold tracking-widest uppercase">巾木を表示</span>
                                                                </label>
                                                                
                                                                {bbEnabled && (
                                                                    <div className="flex items-center gap-2 animate-in fade-in zoom-in duration-200">
                                                                        <div className="flex items-center gap-1.5 bg-black/30 border border-white/10 rounded-lg px-2 py-1">
                                                                            <span className="text-[8px] text-neutral-400 font-bold uppercase">高さ</span>
                                                                            <NumericField
                                                                                value={bbHeight}
                                                                                onChange={(v) =>
                                                                                    setMaterialSettings((prev) => ({
                                                                                        ...prev,
                                                                                        [prodId]: { ...prev[prodId], baseboardHeight: v },
                                                                                    }))
                                                                                }
                                                                                dragSensitivity={2}
                                                                                className="w-16 !border-0 !bg-transparent"
                                                                                inputClassName="text-xs text-right text-white"
                                                                            />
                                                                            <span className="text-[8px] text-neutral-500">mm</span>
                                                                        </div>
                                                                        <div className="relative group/color border border-white/10 rounded-lg overflow-hidden w-6 h-6 shrink-0 cursor-pointer">
                                                                            <input type="color" value={bbColor} onChange={(e) => e.target && setMaterialSettings(prev => ({ ...prev, [prodId]: { ...prev[prodId], baseboardColor: e.target.value } }))} className="absolute -top-2 -left-2 w-10 h-10 cursor-pointer" />
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    );
                                })}

                                {/* 開口部（ドア/窓）のコンパクトプロパティパネル */}
                                {activeOpening && (() => {
                                    const op = activeOpening;
                                    const isDoorOpening = op.type.startsWith('door');
                                    const openingSettings = materialSettings[OPENINGS_MATERIAL_KEY] || {} as any;
                                    const doorColor = openingSettings.doorColor ?? '#8b4513';
                                    const doorFrameColor = openingSettings.doorFrameColor ?? '#444';
                                    const windowFrameColor = openingSettings.windowFrameColor ?? '#333';

                                    const updateOpening = (updates: Partial<Opening>) => {
                                      if (!selectedOpeningId) return;
                                      const current = openings.find(o => o.id === selectedOpeningId);
                                      if (!current) return;

                                      const wall = sketchPoints;
                                      const p1 = wall[current.wallIndex];
                                      const p2 = wall[(current.wallIndex + 1) % wall.length];
                                      const wallLength = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 0.05;

                                      const otherOps = openings.filter(o => o.wallIndex === current.wallIndex && o.id !== current.id);
                                      
                                      let newWidth = updates.width !== undefined ? updates.width : current.width;
                                      let newRatio = updates.ratioPosition !== undefined ? updates.ratioPosition : current.ratioPosition;

                                      // Overlap prevention logic（元のサイドバーと同じ制約を維持）
                                      const currentPos = newRatio * wallLength;
                                      const halfW = getEffectiveOpeningWidthMm({ ...current, width: newWidth }) / 2;
                                      
                                      let minX = halfW;
                                      let maxX = wallLength - halfW;

                                      otherOps.forEach(other => {
                                        const otherPos = other.ratioPosition * wallLength;
                                        const otherHalfW = getEffectiveOpeningWidthMm(other) / 2;
                                        if (otherPos < currentPos) {
                                          minX = Math.max(minX, otherPos + otherHalfW + halfW);
                                        } else {
                                          maxX = Math.min(maxX, otherPos - otherHalfW - halfW);
                                        }
                                      });

                                      if (updates.ratioPosition !== undefined) {
                                        newRatio = Math.max(minX, Math.min(maxX, updates.ratioPosition * wallLength)) / wallLength;
                                      }
                                      
                                      if (updates.width !== undefined) {
                                        const leftBound = otherOps
                                          .filter(o => o.ratioPosition * wallLength < currentPos)
                                          .reduce((max, o) => Math.max(max, o.ratioPosition * wallLength + getEffectiveOpeningWidthMm(o) / 2), 0);
                                        const rightBound = otherOps
                                          .filter(o => o.ratioPosition * wallLength > currentPos)
                                          .reduce((min, o) => Math.min(min, o.ratioPosition * wallLength - getEffectiveOpeningWidthMm(o) / 2), wallLength);
                                        const maxEffectiveW = Math.min(currentPos - leftBound, rightBound - currentPos) * 2;
                                        const maxRawWidth = current.type.startsWith('door')
                                          ? Math.max(0, maxEffectiveW - getEffectiveOpeningWidthMm({ ...current, width: 0 }))
                                          : maxEffectiveW;
                                        newWidth = Math.min(newWidth, maxRawWidth);
                                        const finalHalfW = getEffectiveOpeningWidthMm({ ...current, width: newWidth }) / 2;
                                        newRatio = Math.max(leftBound + finalHalfW, Math.min(rightBound - finalHalfW, currentPos)) / wallLength;
                                      }

                                      // 入力経路に依存せず、開口寸法を最終的に整合する
                                      const minOpeningHeight = Math.min(300, roomHeight);
                                      let nextHeight = updates.height !== undefined ? updates.height : current.height;
                                      let nextBottomOffset = updates.bottomOffset !== undefined ? updates.bottomOffset : current.bottomOffset;

                                      nextHeight = Math.max(minOpeningHeight, Math.min(roomHeight, nextHeight));
                                      nextBottomOffset = Math.max(0, Math.min(roomHeight - nextHeight, nextBottomOffset));

                                      // タイプがドアに変更された場合は、床からの高さを固定
                                      const next: Partial<Opening> = {
                                        ...updates,
                                        width: newWidth,
                                        ratioPosition: newRatio,
                                        height: nextHeight,
                                        bottomOffset: nextBottomOffset,
                                      };
                                      if (
                                        updates.type &&
                                        updates.type.startsWith('door')
                                      ) {
                                        next.bottomOffset = 0;
                                        next.height = Math.max(minOpeningHeight, Math.min(roomHeight, next.height ?? nextHeight));
                                      }

                                      setOpenings(prev => prev.map(o => 
                                        o.id === selectedOpeningId ? { ...o, ...next } : o
                                      ));
                                    };

                                    return (
                                      <div className={`${propertyCardBaseClass} px-4 py-2.5 flex flex-col gap-2`}>
                                        <div className="flex items-start justify-between gap-2 w-full">
                                          <div className="flex flex-col min-w-0">
                                            <span className="text-[10px] font-black uppercase text-emerald-400 tracking-widest truncate">
                                              {OPENING_TYPE_LABELS[op.type] ?? op.type}
                                            </span>
                                            <span className="text-[8px] text-neutral-500 font-bold">
                                              壁 {op.wallIndex + 1} / 中心 {Math.round(op.ratioPosition * 100)}%
                                            </span>
                                          </div>
                                          <div className="flex items-center gap-2 shrink-0">
                                            <div className="flex items-center gap-2 text-[10px] font-mono font-bold text-white bg-black/30 px-2 py-1 rounded-lg">
                                              <span>
                                                {op.width}×{op.height}
                                              </span>
                                              <span className="text-emerald-400">mm</span>
                                            </div>
                                            <button
                                              type="button"
                                              aria-label="開口を削除"
                                              onClick={() => {
                                                setOpenings((prev) => prev.filter((o) => o.id !== selectedOpeningId));
                                                setSelectedOpeningId(null);
                                              }}
                                              className="p-1.5 rounded-lg text-red-400/90 hover:bg-red-500/15 border border-transparent hover:border-red-500/35 transition-colors"
                                            >
                                              <Trash2 className="w-4 h-4" strokeWidth={2} />
                                            </button>
                                          </div>
                                        </div>

                                        <div className="flex flex-col gap-2 w-full pt-2 border-t border-white/10">
                                          <div className="flex items-center gap-2 w-full min-w-0">
                                            <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-10">タイプ</span>
                                            <select
                                              value={op.type}
                                              onChange={(e) => updateOpening({ type: e.target.value as any })}
                                              className="flex-1 min-w-0 bg-black/40 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-white focus:outline-none focus:border-emerald-500/50 transition-colors"
                                            >
                                              <optgroup label="窓">
                                                <option value="window_fix">はめ殺し窓</option>
                                                <option value="window_sliding">引き違い窓</option>
                                                <option value="window_casement">縦すべり出し窓</option>
                                              </optgroup>
                                              <optgroup label="ドア">
                                                <option value="door_single">片開きドア</option>
                                                <option value="door_sliding">引き戸</option>
                                              </optgroup>
                                            </select>
                                          </div>
                                          <div className="flex items-center gap-2 w-full min-w-0">
                                            <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-10">幅</span>
                                            <NumericField
                                              value={op.width}
                                              onChange={(v) => updateOpening({ width: v })}
                                              dragSensitivity={5}
                                              className="flex-1 min-w-0"
                                              inputClassName="text-[10px] text-white py-1 text-right focus-visible:ring-emerald-500/50"
                                            />
                                            <span className="text-[9px] font-mono text-neutral-500 shrink-0">mm</span>
                                          </div>
                                          <div className="flex items-center gap-2 w-full min-w-0">
                                            <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-10">高さ</span>
                                            <NumericField
                                              value={op.height}
                                              onChange={(v) => updateOpening({ height: v })}
                                              dragSensitivity={5}
                                              className="flex-1 min-w-0"
                                              inputClassName="text-[10px] text-white py-1 text-right focus-visible:ring-emerald-500/50"
                                            />
                                            <span className="text-[9px] font-mono text-neutral-500 shrink-0">mm</span>
                                          </div>
                                          {!op.type.startsWith('door') && (
                                            <div className="flex items-center gap-2 w-full min-w-0">
                                              <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-10">床高</span>
                                              <NumericField
                                                value={op.bottomOffset}
                                                onChange={(v) => updateOpening({ bottomOffset: v })}
                                                dragSensitivity={5}
                                                className="flex-1 min-w-0"
                                                inputClassName="text-[10px] text-white py-1 text-right focus-visible:ring-emerald-500/50"
                                              />
                                              <span className="text-[9px] font-mono text-neutral-500 shrink-0">mm</span>
                                            </div>
                                          )}
                                        </div>
                                        <div className="flex flex-col gap-2 w-full pt-2 border-t border-white/10">
                                          <div className="flex flex-col">
                                            <span className="text-[9px] font-black uppercase text-emerald-400 tracking-wider">開口部カラー</span>
                                            <span className="text-[8px] text-neutral-500 font-bold">
                                              {isDoorOpening ? 'ドア・ドア枠' : '窓枠'}
                                            </span>
                                          </div>
                                          {isDoorOpening ? (
                                            <>
                                              <div className="flex items-center justify-between">
                                                <span className="text-[10px] text-neutral-300 font-bold">ドア色</span>
                                                <input
                                                  type="color"
                                                  value={doorColor}
                                                  onChange={(e) => setMaterialSettings((prev) => ({
                                                    ...prev,
                                                    [OPENINGS_MATERIAL_KEY]: { ...prev[OPENINGS_MATERIAL_KEY], doorColor: e.target.value },
                                                  }))}
                                                  className="w-8 h-8 cursor-pointer rounded border border-white/10 bg-transparent"
                                                />
                                              </div>
                                              <div className="flex items-center justify-between">
                                                <span className="text-[10px] text-neutral-300 font-bold">ドア枠色</span>
                                                <input
                                                  type="color"
                                                  value={doorFrameColor}
                                                  onChange={(e) => setMaterialSettings((prev) => ({
                                                    ...prev,
                                                    [OPENINGS_MATERIAL_KEY]: { ...prev[OPENINGS_MATERIAL_KEY], doorFrameColor: e.target.value },
                                                  }))}
                                                  className="w-8 h-8 cursor-pointer rounded border border-white/10 bg-transparent"
                                                />
                                              </div>
                                            </>
                                          ) : (
                                            <div className="flex items-center justify-between">
                                              <span className="text-[10px] text-neutral-300 font-bold">窓枠色</span>
                                              <input
                                                type="color"
                                                value={windowFrameColor}
                                                onChange={(e) => setMaterialSettings((prev) => ({
                                                  ...prev,
                                                  [OPENINGS_MATERIAL_KEY]: { ...prev[OPENINGS_MATERIAL_KEY], windowFrameColor: e.target.value },
                                                }))}
                                                className="w-8 h-8 cursor-pointer rounded border border-white/10 bg-transparent"
                                              />
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })()}

                                {activeFurnitureId && (() => {
                                    const activeItem = furnitureItems.find((f) => f.id === activeFurnitureId);
                                    if (!activeItem) return null;
                                    const displayTitle =
                                        (activeItem as any).customName ??
                                        activeItem.name ??
                                        activeItem.type ??
                                        '—';
                                    const displaySub = (activeItem as any).customBrand ?? activeItem.type ?? '—';
                                    const priceVal = Number.isFinite((activeItem as any).customPrice)
                                        ? (activeItem as any).customPrice
                                        : 0;
                                    return (
                                        <div className={`${propertyCardBaseClass} px-4 py-2.5 flex flex-col gap-2`}>
                                            <div className="flex items-start justify-between gap-2 w-full">
                                                <div className="flex flex-col min-w-0 flex-1">
                                                    <span className="text-[10px] font-black uppercase text-emerald-400 tracking-widest truncate">
                                                        {displayTitle}
                                                    </span>
                                                    <span className="text-[8px] text-neutral-500 font-bold truncate">{displaySub}</span>
                                                </div>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    <div className="flex items-center gap-1 text-[10px] font-mono font-bold bg-black/30 px-2 py-1 rounded-lg min-w-0">
                                                        <span className="text-emerald-400 shrink-0">¥</span>
                                                        <NumericField
                                                            value={priceVal}
                                                            onChange={(v) =>
                                                                setFurnitureItems((prev) =>
                                                                    prev.map((f) =>
                                                                        f.id === activeFurnitureId ? { ...f, customPrice: v } : f
                                                                    )
                                                                )
                                                            }
                                                            dragSensitivity={50}
                                                            className="flex-1 min-w-[4rem] !border-0 !bg-transparent"
                                                            inputClassName="text-[10px] text-emerald-400 py-0.5 text-right tabular-nums focus-visible:ring-emerald-500/50"
                                                        />
                                                    </div>
                                                    <button
                                                        type="button"
                                                        aria-label="家具を削除"
                                                        onClick={() => {
                                                            setFurnitureItems((prev) => prev.filter((p) => p.id !== activeFurnitureId));
                                                            setActiveFurnitureId(null);
                                                        }}
                                                        className="p-1.5 rounded-lg text-red-400/90 hover:bg-red-500/15 border border-transparent hover:border-red-500/35 transition-colors shrink-0"
                                                    >
                                                        <Trash2 className="w-4 h-4" strokeWidth={2} />
                                                    </button>
                                                </div>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const ceilingY = roomHeight / 1000;
                                                    setFurnitureItems((prev) =>
                                                        prev.map((f) => {
                                                            if (f.id !== activeFurnitureId) return f;
                                                            const toCeiling = !f.ceilingMount;
                                                            return {
                                                                ...f,
                                                                ceilingMount: toCeiling,
                                                                position: [
                                                                    f.position[0],
                                                                    toCeiling ? ceilingY : 0,
                                                                    f.position[2],
                                                                ] as [number, number, number],
                                                            };
                                                        })
                                                    );
                                                }}
                                                className={`w-full text-[10px] font-bold rounded-lg px-2 py-1.5 border transition-colors ${
                                                    activeItem.ceilingMount
                                                        ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                                                        : 'bg-black/30 border-white/10 text-neutral-300 hover:bg-white/5'
                                                }`}
                                            >
                                                {activeItem.ceilingMount ? '✓ 天井に配置中（解除）' : '天井に配置'}
                                            </button>

                                            <div className="flex items-start gap-3 w-full pt-2 border-t border-white/10">
                                                <div className="w-12 h-12 rounded-lg overflow-hidden border border-white/10 shrink-0 bg-neutral-800">
                                                    <ModelThumbnail
                                                        url={activeItem.modelUrl}
                                                        name={(activeItem as any).customName || activeItem.name || activeItem.type}
                                                    />
                                                </div>
                                                <div className="flex-1 min-w-0 flex flex-col gap-2">
                                                    <div className="flex items-center gap-2 w-full min-w-0">
                                                        <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-10">ブランド</span>
                                                        <input
                                                            type="text"
                                                            value={(activeItem as any).customBrand ?? activeItem.type ?? ''}
                                                            onChange={(e) => {
                                                                setFurnitureItems((prev) =>
                                                                    prev.map((f) =>
                                                                        f.id === activeFurnitureId
                                                                            ? { ...f, customBrand: e.target.value }
                                                                            : f
                                                                    )
                                                                );
                                                            }}
                                                            className="flex-1 min-w-0 bg-black/40 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-white focus:outline-none focus:border-emerald-500/50 transition-colors"
                                                        />
                                                    </div>
                                                    <div className="flex items-center gap-2 w-full min-w-0">
                                                        <span className="text-[9px] text-neutral-300 font-bold shrink-0 w-10">商品名</span>
                                                        <input
                                                            type="text"
                                                            value={(activeItem as any).customName ?? activeItem.name ?? ''}
                                                            onChange={(e) => {
                                                                setFurnitureItems((prev) =>
                                                                    prev.map((f) =>
                                                                        f.id === activeFurnitureId
                                                                            ? { ...f, customName: e.target.value }
                                                                            : f
                                                                    )
                                                                );
                                                            }}
                                                            className="flex-1 min-w-0 bg-black/40 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-white focus:outline-none focus:border-emerald-500/50 transition-colors"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        );
                    })()}
                    </div>

                            {/* --- BOTTOM ROW (Debug, Camera presets, Furniture) --- */}
                            <div className="absolute bottom-6 left-6 right-6 z-40 flex items-end justify-between gap-3 pointer-events-none">
                                <div className="flex-1 min-w-0 flex justify-start">
                                    {renderState.debugBaseUrl ? (
                                        <div className="group cursor-pointer pointer-events-auto animate-in fade-in slide-in-from-bottom-4" onClick={() => setShowDebugModal(true)}>
                                            <div className="relative border border-white/20 bg-black p-1 rounded-xl shadow-2xl transition-transform hover:scale-105 overflow-hidden w-40">
                                                <div className="absolute top-0 left-0 right-0 bg-black/80 backdrop-blur text-white text-[8px] px-2 py-1 font-bold z-10 flex justify-between items-center">
                                                    <span>デバッグ</span><span className="text-emerald-400">READY</span>
                                                </div>
                                                <img src={renderState.debugBaseUrl} className="w-full h-auto opacity-70 group-hover:opacity-100 transition-opacity mt-4 rounded-lg" alt="Debug" />
                                            </div>
                                        </div>
                                    ) : null}
                                </div>

                                <div className="shrink-0 flex items-stretch justify-center gap-2 pointer-events-none">
                                    <div className="glass px-2.5 py-2 rounded-xl border border-white/10 bg-black/50 backdrop-blur-md max-w-[min(40vw,200px)] w-[min(40vw,168px)] shrink-0 self-stretch min-h-0 flex flex-col overflow-hidden pointer-events-auto">
                                        <p className="text-[9px] font-black uppercase text-neutral-400 tracking-wider mb-1.5 shrink-0">操作</p>
                                        <ul className="flex-1 min-h-0 max-h-full overflow-y-auto space-y-1 text-[9px] leading-snug text-neutral-200 font-semibold py-0.5">
                                            {cameraMode === 'orbit' ? (
                                                <>
                                                    <li>
                                                        <span className="text-white/90">左ドラッグ</span> 視点回転
                                                    </li>
                                                    <li>
                                                        <span className="text-white/90">右ドラッグ</span> パン
                                                    </li>
                                                    <li>
                                                        <span className="text-white/90">ホイール</span> ズーム
                                                    </li>
                                                    <li>
                                                        <span className="text-white/90">クリック</span> 面・家具選択
                                                    </li>
                                                </>
                                            ) : (
                                                <>
                                                    <li>
                                                        <span className="text-white/90">左ドラッグ</span> 視線
                                                    </li>
                                                    <li>
                                                        <span className="text-white/90">WASD / 矢印</span> 移動
                                                    </li>
                                                    <li>
                                                        <span className="text-white/90">Q / E</span> 左右旋回
                                                    </li>
                                                    <li>
                                                        <span className="text-white/90">Shift</span> 低速移動
                                                    </li>
                                                </>
                                            )}
                                        </ul>
                                    </div>
                                    <CameraPresetBar
                                        presets={cameraPresets}
                                        lastAppliedId={lastAppliedPresetId}
                                        disabled={
                                            renderState.isRendering ||
                                            snapshotMode ||
                                            maskMode ||
                                            captureStep !== 'idle'
                                        }
                                        cameraMode={cameraMode}
                                        onCameraModeChange={handleCameraModeChange}
                                        cameraFov={cameraFov}
                                        onCameraFovChange={setCameraFov}
                                        eyeHeightMm={eyeHeightMm}
                                        onEyeHeightMmChange={setEyeHeightMm}
                                        onSaveCurrent={handleSaveCameraPreset}
                                        onApply={applyCameraPreset}
                                        onDelete={handleDeleteCameraPreset}
                                        onRename={handleRenameCameraPreset}
                                    />
                                    {cameraMode === 'walk' &&
                                        !(
                                            renderState.isRendering ||
                                            snapshotMode ||
                                            maskMode ||
                                            captureStep !== 'idle'
                                        ) && (
                                            <WalkMovePad
                                                disabled={false}
                                                walkDigitalInputRef={walkDigitalInputRef}
                                                className="self-center"
                                            />
                                        )}
                                </div>

                                <div className="flex-1 min-w-0 flex justify-end">
                                    <FurnitureAssetStrip
                                        processedCatalog={processedCatalog}
                                        assetCategories={assetCategories}
                                        selectedAssetCategory={selectedAssetCategory}
                                        onSelectedAssetCategoryChange={setSelectedAssetCategory}
                                        onPickItem={handleAddFurniture}
                                        renderThumbnail={(item) => <ModelThumbnail url={item.url} name={item.name} />}
                                        fetchStatus={furnitureCatalogFetchStatus}
                                        fetchErrorMessage={furnitureCatalogErrorText}
                                    />
                                </div>
                            </div>
                    </>
                </div>
             )}
          </div>

          {viewMode === 'sketch' && (
          <div className="absolute bottom-6 left-6 z-30 glass p-5 rounded-3xl border border-white/10 shadow-2xl bg-black/60 backdrop-blur-xl pointer-events-none transition-all">
              <h3 className="text-[10px] font-black text-neutral-400 mb-4 uppercase tracking-widest flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  操作ガイド
              </h3>
              <ul className="space-y-3 text-xs font-bold text-neutral-200">
                      <li className="flex items-center gap-3">
                          <div className="bg-white/10 p-2 rounded-xl border border-white/10"><MouseLeftClick /></div> 
                          <span className="text-neutral-300 text-[11px]"><strong className="text-white">左クリック:</strong> 壁を描画 / 確定</span>
                      </li>
                      <li className="flex items-center gap-3">
                          <div className="bg-white/10 p-2 rounded-xl border border-white/10"><MouseRightClick /></div> 
                          <span className="text-neutral-300 text-[11px]"><strong className="text-white">右ドラッグ:</strong> キャンセル / 画面移動</span>
                      </li>
                      <li className="flex items-center gap-3">
                          <div className="bg-white/10 p-2 rounded-xl border border-white/10"><MouseWheel /></div> 
                          <span className="text-neutral-300 text-[11px]"><strong className="text-white">ホイール:</strong> ズーム</span>
                      </li>
              </ul>
          </div>
          )}

      </div>

      {/* --- RIGHT SIDEBAR (Catalog + Cost) --- */}
      {viewMode === '3D' && (
        <aside className="relative w-[min(440px,92vw)] h-full flex flex-col z-20 shrink-0 shadow-2xl animate-in slide-in-from-right duration-500 bg-[#050505] border-l border-white/5">
          {/* 1. ESTIMATED COST (Top) */}
          {renderEstimatePanel(false)}

          {/* MATERIAL CATALOG */}
          <div className="flex-1 flex flex-col min-h-0 relative z-10 bg-[#050505]">
            <div className="flex-1 overflow-y-auto px-6 pt-0 pb-6 space-y-2 md:px-8 md:pb-8 md:space-y-3 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                
                {/* サムネ表示密度（左） / 並び替え（右） */}
                <div className="flex items-center justify-end gap-3 mb-2 flex-wrap">
                    <div
                        className="flex items-center gap-2 min-w-0"
                        title="左: リスト → 右へ: タイル（小・多列）→ タイル（大・少列）"
                    >
                        <LayoutList className="w-3.5 h-3.5 text-neutral-500 shrink-0" aria-hidden />
                        <input
                            type="range"
                            min={1}
                            max={4}
                            step={1}
                            value={CATALOG_GRID_TO_SLIDER[catalogGridSize] ?? 2}
                            onChange={(e) => {
                                const v = parseInt(e.target.value, 10);
                                if (!Number.isFinite(v)) return;
                                const clamped = Math.min(4, Math.max(1, v));
                                const next = CATALOG_SLIDER_TO_GRID[clamped];
                                if (next !== undefined) setCatalogGridSize(next);
                            }}
                            className="catalog-thumb-size-slider h-1 w-[88px] cursor-pointer accent-emerald-500 shrink-0"
                            aria-label="表示: 左がリスト、右へタイル小から大へ"
                        />
                        <LayoutGrid className="w-3.5 h-3.5 text-neutral-500 shrink-0" aria-hidden />
                    </div>
                    <div className="relative shrink-0" ref={catalogSortMenuRef}>
                        <button
                            type="button"
                            title="並び替え"
                            aria-expanded={catalogSortMenuOpen}
                            aria-haspopup="listbox"
                            onClick={() => setCatalogSortMenuOpen((o) => !o)}
                            className="relative h-9 w-9 flex items-center justify-center rounded-lg border border-white/10 bg-[#111] text-neutral-300 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            <ArrowUpDown className="w-4 h-4" aria-hidden />
                        </button>
                        {catalogSortMenuOpen && (
                            <ul
                                role="listbox"
                                className="absolute right-0 top-full z-50 mt-1 min-w-[220px] rounded-xl border border-white/10 bg-[#0d0d0d] py-1 shadow-2xl"
                            >
                                {CATALOG_SORT_OPTIONS.map((opt) => (
                                    <li key={opt.value} role="presentation">
                                        <button
                                            type="button"
                                            role="option"
                                            aria-selected={sortOrder === opt.value}
                                            className={`w-full text-left px-3 py-2.5 text-[10px] font-bold transition-colors ${
                                                sortOrder === opt.value
                                                    ? 'bg-emerald-500/15 text-emerald-400'
                                                    : 'text-neutral-200 hover:bg-white/10 hover:text-white'
                                            }`}
                                            onClick={() => {
                                                setSortOrder(opt.value);
                                                setCatalogSortMenuOpen(false);
                                            }}
                                        >
                                            {opt.label}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
                  
                {/* Category & Brand Chips */}
                <div className="flex flex-col gap-3">
                  <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar -mx-2 px-2">
                    {availableCategories.length > 0 ? (
                        availableCategories.map(cat => (
                          <button key={cat} onClick={() => setActiveCategory(cat as any)} className={`shrink-0 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase transition-all whitespace-nowrap border ${activeCategory === cat ? 'bg-white text-black border-white shadow-lg' : 'bg-[#111] text-neutral-500 border-white/5 hover:border-white/20 hover:text-white'}`}>
                            {categoryLabels[cat]?.split('(')[0] || cat}
                          </button>
                        ))
                    ) : ( ['Floor', 'Wall', 'Ceiling'].map(cat => ( <div key={cat} className="w-20 h-9 rounded-xl bg-white/5 animate-pulse shrink-0"></div> )) )}
                  </div>
                  {availableBrands.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-4 no-scrollbar -mx-2 px-2 items-center">
                      <button onClick={() => setSelectedBrand(null)} className={`shrink-0 h-7 px-3 rounded-full text-[9px] font-bold uppercase border transition-all flex items-center ${!selectedBrand ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400' : 'bg-transparent border-white/10 text-neutral-500 hover:text-white'}`}>すべてのブランド</button>
                      <label className="shrink-0 h-7 px-4 rounded-full text-[9px] font-bold border bg-emerald-500/10 border-emerald-500 text-emerald-400 hover:bg-emerald-500 hover:text-black transition-all flex items-center cursor-pointer">+ 素材を追加<input type="file" multiple accept="image/*" className="hidden" onChange={handleMaterialUpload} /></label>
                      {availableBrands.map(brand => (
                        <button key={brand} onClick={() => setSelectedBrand(brand)} className={`shrink-0 h-7 px-3 rounded-full text-[9px] font-bold uppercase border transition-all flex items-center ${selectedBrand === brand ? 'bg-white text-black border-white' : 'bg-transparent border-white/10 text-neutral-500 hover:text-white'}`}>{brand}</button>
                      ))}
                    </div>
                  )}
                </div>
                  
                {/* Product Grid (Dynamic Size based on catalogGridSize) */}
                <div className="min-h-[200px] pb-12">
                    {isLoadingProducts ? (
                        <div className="grid grid-cols-2 gap-3">{[1,2,3,4].map(i => <div key={i} className="aspect-square rounded-2xl bg-white/5 animate-pulse"></div>)}</div>
                    ) : fetchError ? (
                        <div className="text-center py-12 bg-red-500/10 rounded-2xl border border-red-500/20"><div className="text-red-400 text-xs font-bold mb-2">⚠ 通信エラー</div></div>
                    ) : activeCategory ? (
                      filteredProducts.length > 0 ? (
                        <div
                            className="grid gap-3"
                            style={{
                                gridTemplateColumns:
                                    Math.max(1, 5 - catalogGridSize) === 1
                                        ? '1fr'
                                        : `repeat(${Math.max(1, 5 - catalogGridSize)}, minmax(0, 1fr))`,
                            }}
                        >
                            {filteredProducts.map(product => {
                                const isSelected = activeMeshes.some(m => selections[m]?.id === product.id);
                                const gridCols = Math.max(1, 5 - catalogGridSize);
                                // List View (When Grid Size Slider is max 4 -> gridCols = 1)
                                if (gridCols === 1) {
                                    return (
                                        <button key={product.id} disabled={activeMeshes.length === 0} onClick={() => handleProductSelect(product)} className={`flex items-center gap-3 p-2 rounded-xl border transition-all text-left ${isSelected ? 'border-emerald-500 bg-emerald-500/5' : 'border-white/5 hover:border-white/20 bg-[#111]'} ${activeMeshes.length === 0 ? 'opacity-50 grayscale' : ''}`}>
                                            <img src={getThumbnailUrl(product.textureUrl)} className="w-12 h-12 rounded-lg object-cover bg-neutral-900 shrink-0" alt="" />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-[8px] font-black text-emerald-400 uppercase tracking-wider">{product.brand}</div>
                                                <div className="text-[11px] font-bold text-white truncate">{product.name}</div>
                                            </div>
                                            <div className="text-right shrink-0 px-2 font-mono text-xs text-neutral-300">¥{product.pricePerUnit.toLocaleString()}</div>
                                        </button>
                                    );
                                }
                                // Grid View (Grid Size > 1)
                                return (
                                    <button key={product.id} disabled={activeMeshes.length === 0} onClick={() => handleProductSelect(product)} className={`group relative aspect-square md:aspect-[4/5] rounded-2xl overflow-hidden border transition-all duration-300 ${isSelected ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.2)]' : 'border-white/5 hover:border-white/30'} ${activeMeshes.length === 0 ? 'opacity-50 grayscale' : ''}`}>
                                        <div className="absolute inset-0 bg-neutral-900">
                                            <img src={getThumbnailUrl(product.textureUrl)} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" alt={product.name} />
                                            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80" />
                                        </div>
                                        <div className="absolute inset-0 p-3 flex flex-col justify-end text-left">
                                            <div className="text-[8px] font-black text-emerald-400 uppercase tracking-wider mb-1">{product.brand}</div>
                                            <h3 className="text-[10px] font-bold text-white leading-tight line-clamp-2 mb-1.5">{product.name}</h3>
                                            <span className="font-mono text-xs text-neutral-300">¥{product.pricePerUnit.toLocaleString()}</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                      ) : ( <div className="text-center py-12 text-neutral-600 text-xs font-black uppercase">素材が見つかりません</div> )
                    ) : (
                      <div className="text-center py-16 bg-white/5 rounded-2xl border border-dashed border-white/10 flex flex-col items-center justify-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center text-neutral-500"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 15l-2 5L9 9l11 4-5 2z" /></svg></div>
                        <p className="text-neutral-500 text-[10px] font-black uppercase tracking-[0.2em] text-center">3D面を選択してください</p>
                      </div>
                    )}
                </div>
            </div>
          </div>

        </aside>
      )}

      {estimateGuardOpen && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-[#121212] p-5 shadow-2xl">
            <h3 className="mb-2 text-sm font-black tracking-wide text-amber-300">未入力項目があります</h3>
            <p className="text-xs text-neutral-300">
              ダウンロード前に入力不足を確認してください。このまま続行することもできます。
            </p>
            <div className="mt-4 space-y-2 text-xs">
              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                <span className="text-neutral-400">家具の価格未入力</span>
                <span className="font-black text-white">{furnitureMissingCount}件</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                <span className="text-neutral-400">AI追加アイテム未入力</span>
                <span className="font-black text-white">{aiEstimateMissingCount}件</span>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={focusFurnitureInputs}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-[11px] font-black text-neutral-200 hover:bg-white/10"
              >
                家具入力へ
              </button>
              <button
                type="button"
                onClick={focusAiInputs}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-[11px] font-black text-neutral-200 hover:bg-white/10"
              >
                AI追加入力へ
              </button>
              <button
                type="button"
                onClick={() => {
                  setEstimateGuardOpen(false);
                  setPendingExportKind(null);
                }}
                className="ml-auto rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-[11px] font-black text-neutral-300 hover:bg-white/10"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleGuardContinueExport}
                className="rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-2 text-[11px] font-black text-amber-200 hover:bg-amber-500/30"
              >
                このままダウンロード
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI処理中（デノイズ or 生成 or レンダリング）のリッチなUI */}
      {(isDenoising || renderState.isRendering) && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-zinc-950/90 backdrop-blur-sm">
          <div className="p-8 bg-zinc-900/80 rounded-2xl border border-zinc-800 shadow-2xl flex flex-col items-center gap-6 text-center">
             <Wand2 className="w-16 h-16 text-purple-500 animate-pulse" />
             <div>
               <h3 className="font-bold text-2xl mb-3 bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
                  {isDenoising ? 'AIで画像処理中...' : 'クラウドAIで超高画質レンダリング中...'}
               </h3>
               <p className="text-zinc-400 text-sm">最高峰の建築ビジュアライゼーションモデルが処理を実行しています</p>
             </div>
          </div>
        </div>
      )}

                    <AiEditWorkspace
                        isOpen={aiEditOpen}
                        viewMode={viewMode}
                        canSwitchTo3D={canNavigateTo3D}
                        onSwitchToSketch={navigateToSketch}
                        onSwitchTo3D={navigateTo3D}
                        onSwitchToAiEdit={navigateToAiEdit}
                        versions={aiEditSession.versions}
                        activeVersionId={aiEditSession.activeVersionId}
                        activeVersion={aiEditSession.activeVersion}
                        onSelectVersion={aiEditSession.selectVersion}
                        draftStyleRefDataUrl={aiEditSession.draftStyleRefDataUrl}
                        onStyleRefChange={aiEditSession.setStyleRef}
                        draftStyleMemo={aiEditSession.draftStyleMemo}
                        onStyleMemoChange={aiEditSession.setDraftStyleMemo}
                        draftObjects={aiEditSession.draftObjects}
                        onAddObject={() => aiEditSession.addObjectDraft()}
                        onUpdateObjectImage={aiEditSession.updateObjectImage}
                        onRemoveObject={aiEditSession.removeObject}
                        onUpdateObjectMemo={aiEditSession.updateObjectMemo}
                        activeObjectId={aiEditSession.activeObjectId}
                        onActiveObjectChange={aiEditSession.setActiveObjectId}
                        placementEditIndex={aiEditSession.placementEditIndex}
                        onSetAppendPlacementMode={aiEditSession.setAppendPlacementMode}
                        onSetReplacePlacementMode={aiEditSession.setReplacePlacementMode}
                        onCommitPlacementRect={aiEditSession.commitPlacementRect}
                        onRemovePlacementAt={aiEditSession.removePlacementAt}
                        estimatePanel={renderEstimatePanel(true)}
                        onEditSuccess={(p) => {
                            aiEditSession.appendVersionAfterEdit({
                                parentId: p.parentId,
                                baseImageDataUrl: p.baseImageDataUrl,
                                outputImageDataUrl: p.outputImageDataUrl,
                                styleRefDataUrl: p.styleRefDataUrl,
                                styleMemo: p.styleMemo,
                                objects: p.objects,
                            });
                            setRenderState((prev) => ({
                                ...prev,
                                resultImageUrl: p.outputImageDataUrl,
                            }));
                        }}
                    />

                    {/* Debug Modal */}
                    {showDebugModal && (
                        <div className="fixed inset-0 w-screen h-screen bg-black/90 backdrop-blur-xl z-[9999] flex items-center justify-center p-8 pointer-events-auto" onClick={() => setShowDebugModal(false)}>
                            <div className="relative max-w-6xl w-full border border-white/20 p-6 rounded-2xl bg-[#0a0a0a] flex flex-col md:flex-row gap-6 shadow-2xl" onClick={e => e.stopPropagation()}>
                                <button className="absolute -top-4 -right-4 text-white bg-black border border-white/20 w-10 h-10 rounded-full hover:bg-white/20 z-10 font-bold" onClick={() => setShowDebugModal(false)}>✕</button>
                                <div className="flex-1 relative bg-black rounded-xl p-2 border border-white/5 flex flex-col md:flex-row gap-4">
                                  <div className="flex-1">
                                      <p className="text-emerald-400 font-mono text-[10px] mb-2 font-bold tracking-widest">STEP 1: BASE (CLAY)</p>
                                      <img src={renderState.debugBaseUrl || ''} className="w-full h-auto rounded-lg object-contain" alt="Debug Base" />
                                  </div>
                                  {renderState.debugMaskUrl && (
                                      <div className="flex-1">
                                          <p className="text-emerald-400 font-mono text-[10px] mb-2 font-bold tracking-widest">STEP 1: MASK</p>
                                          <img src={renderState.debugMaskUrl} className="w-full h-auto rounded-lg object-contain border border-white/10" alt="Debug Mask" />
                                      </div>
                                  )}
                                </div>
                            </div>
                        </div>
                    )}
    </div>
  );
};

export default App;