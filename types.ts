import { ThreeElements } from '@react-three/fiber';
import type { MaterialPhysical } from './lib/materialPhysical.js';

export interface Point {
  x: number;
  y: number;
}

export type MaterialCategory = 'Floor' | 'Wall' | 'Ceiling' | 'Furniture' | 'Window';

export type FurnitureType = 'Sofa' | 'Table' | 'Bed' | 'Chair' | 'Shelf';

export interface FurnitureItem {
  id: string;
  type: string;
  name: string;
  modelUrl: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  /** GLTF 計測のスケール1時の床面相当サイズ（mm）。未設定時は名前ヒューリスティクス */
  modelFootprintBaseMm?: { width: number; depth: number };
  /** 2D軽量表示専用の足跡（mm）。実行時計測を避けるための優先値 */
  footprint2d?: { width: number; depth: number };
  /** モデルが正面を向く基準ヨー角（度）。2D/3D初期向きの共通基準 */
  modelForwardYawDeg?: number;
  customName?: string;
  customBrand?: string;
  customPrice?: number;
  /** 天井オブジェクトとして天井高に配置するか（true のとき position[1] を天井高に置く） */
  ceilingMount?: boolean;
}

export interface FurnitureCatalogItem {
  id: string;
  type: string;
  name: string;
  url: string;
  defaultY?: number;
  defaultScale?: number;
  footprint2d?: { widthMm: number; depthMm: number };
  forwardYawDeg?: number;
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: MaterialCategory;
  pricePerUnit: number;
  unit: string;
  lossFactor: number; // e.g., 0.05 for 5% loss
  textureUrl: string;
  color: string; // 3D空間での簡易表現用カラー (Hex)
  pbr: {
    roughness: number;
    metalness: number;
    reflectivity: number;
    glossiness: string;
    normalMapStrength: number;
  };
  promptHint: string;
  /**
   * 実寸テクスチャ投影用の物理メタデータ（mm）。/api/materials が画像仕様から導出。
   * RoomViewer の applyRealSizeTextureRepeat に渡すことで、面の実寸 ÷ テクスチャ実寸から
   * リピート幅を自動計算する。未取得時は undefined（従来の短辺指定にフォールバック）。
   */
  physical?: MaterialPhysical;
}

export interface SelectionState {
  meshName: string | null;
  category: MaterialCategory | null;
  currentProduct: Product | null;
}

export type OpeningType = 'window_fix' | 'window_sliding' | 'window_casement' | 'door_single' | 'door_sliding';

export type ToolMode = 'select' | 'draw' | 'add';
export type AddKind = 'door' | 'window' | 'furniture';

export interface Opening {
  id: string;
  type: OpeningType;
  wallIndex: number;      // どの壁に属するか（線分のインデックス）
  ratioPosition: number;  // 壁の始点から終点のどの位置にあるか (0.0 〜 1.0)
  width: number;
  height: number;
  bottomOffset: number;   // 床からの高さ (ドアの場合は0)
}

export interface RenderState {
  isRendering: boolean;
  resultImageUrl: string | null;
  generationLog: string[];
  debugBaseUrl?: string | null;
  debugMaskUrl?: string | null;
}

/** AI画像編集のモード（UIラベルと対応） */
export type AiEditMode = 'lighting_atmosphere' | 'furniture_fixture' | 'joinery';

/** 参照画像のロール（レイアウト参考は使わない） */
export type AiEditReferenceRole = 'style' | 'object';

/** ベース画像上の配置矩形（0〜1 正規化） */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** オブジェクト参照1件（参照画像1枚に対し複数配置矩形＝B案） */
export interface AiEditObjectReference {
  id: string;
  /** 画像なし（テキストのみ）のエリア編集も許可 */
  imageDataUrl: string | null;
  /** ベース画像上の配置矩形（正規化）。同一オブジェクトを複数箇所に置く場合は複数要素 */
  placements: NormalizedRect[];
  /** 後方互換用の全体メモ（未使用時は空文字） */
  memo: string;
  /** placements と同じインデックスを持つエリア別テキスト */
  placementMemos: string[];
}

/** 編集履歴の1バージョン（実行完了後のスナップショット） */
export interface AiEditVersion {
  id: string;
  parentId: string | null;
  createdAt: number;
  /** この生成に使った入力ベース画像 */
  baseImageDataUrl: string;
  /** 生成結果 */
  outputImageDataUrl: string;
  styleRefDataUrl: string | null;
  /** スタイル参照画像用の短い補足（任意） */
  styleMemo: string;
  objects: AiEditObjectReference[];
}

/** AI画像編集由来の追加見積アイテム（3D未配置の仮項目） */
export interface AiEstimateItem {
  id: string;
  name: string;
  brand: string;
  price?: number;
  memo?: string;
}

/** 3D カメラプリセット。cameraMode 省略時は自由視点（Orbit） */
export interface CameraPreset {
  id: string;
  label: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** 省略時は orbit（後方互換） */
  cameraMode?: 'orbit' | 'free' | 'walk';
  /** 自由視点保存時のヨー・ピッチ（rad） */
  freeYaw?: number;
  freePitch?: number;
  /** ウォークスルー保存時のヨー・ピッチ（rad） */
  walkYaw?: number;
  walkPitch?: number;
}

/** Canvas 内でカメラを補間移動するときのリクエスト */
export interface CameraBlendRequest {
  token: number;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export type TextureScaleSyncMode = 'manual' | 'from2d';

export interface TextureScaleSyncSource {
  sourceKind: 'wall' | 'floor' | 'ceiling';
  sourceId: string;
  measuredMm: number;
}

declare global {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}
