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
  /** GLTF 計測のスケール1時の高さ（mm・Y）。寸法編集の高さ基準に使う（260717）。未設定は背景計測で補完。 */
  modelBaseHeightMm?: number;
  /**
   * 取り込み単位(③・260717)の幾何プリスケール f_U（描画側 ClayModel と計測が同一適用する）。
   * 設定時は exoticNormalizeScale のヒューリスティクスを使わずこの係数でジオメトリを実寸化する。
   * これにより footprint2d/描画が実寸で一致し FurnitureItem.scale は 1 のまま扱える。未設定は既定挙動。
   */
  modelUnitScale?: number;
  /** 2D軽量表示専用の足跡（mm）。実行時計測を避けるための優先値 */
  footprint2d?: { width: number; depth: number };
  /** モデルが正面を向く基準ヨー角（度）。2D/3D初期向きの共通基準 */
  modelForwardYawDeg?: number;
  customName?: string;
  customBrand?: string;
  customPrice?: number;
  /** 見積もりの備考メモ（4c）。scene.furniture に含まれ永続化される。 */
  customMemo?: string;
  /** 商品の品番/型番（見積用・任意・260619 クライアント要望）。scene.furniture に含まれ永続化される。 */
  modelNumber?: string;
  /** 商品ページの URL（見積用・任意・260619）。 */
  productUrl?: string;
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
  /** 取り込み単位(③・260717)の幾何プリスケール f_U。配置時に FurnitureItem.modelUnitScale へ引き継ぐ。 */
  modelUnitScale?: number;
  /** 見積もり連携用の商品メタ（任意・260620 Tier1）。未設定時は配置時に furnitureProductMeta から補完する。 */
  brand?: string;
  /** 品番/型番。 */
  modelNumber?: string;
  /** 単価（円）。見積もりの「単価 × 数量」に使う。 */
  price?: number;
  /** 商品ページURL。 */
  productUrl?: string;
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  /** 品番（任意・建材アップロード時に入力）。見積もりに表示する（260630・クライアント要望）。 */
  modelNumber?: string;
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
  /**
   * カテゴリ横断表示フラグ。true のときカテゴリ絞り込みを無視して全カテゴリのパレットに表示する。
   * ユーザーアップロードのテクスチャで「共通（壁/床/天井いずれにも未割当）」の場合に使う。
   * 通常の素材（Cloudinary カタログ）やカテゴリ割当済みアップロードでは undefined（=自カテゴリのみ）。
   */
  crossCategory?: boolean;
}

export interface SelectionState {
  meshName: string | null;
  category: MaterialCategory | null;
  currentProduct: Product | null;
}

export type OpeningType = 'window_fix' | 'window_sliding' | 'window_casement' | 'door_single' | 'door_sliding';

export type ToolMode = 'select' | 'draw' | 'add' | 'beam';
export type AddKind = 'door' | 'window' | 'furniture';

export interface Opening {
  id: string;
  type: OpeningType;
  wallIndex: number;      // どの壁に属するか（線分のインデックス）
  ratioPosition: number;  // 壁の始点から終点のどの位置にあるか (0.0 〜 1.0)
  width: number;
  height: number;
  bottomOffset: number;   // 床からの高さ (ドアの場合は0)
  /** ドアの吊り元（左右）反転。未設定=既定。 */
  swingFlipX?: boolean;
  /** ドアの開く向き（内外）反転。未設定=室内側へ開く（描画方向に依存しない）。 */
  swingFlipY?: boolean;
  /** ドアの開閉状態（3Dビューの見た目）。未設定/false=閉じた状態（既定）、true=開いた状態。 */
  swingOpen?: boolean;
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
  /**
   * 多角形マスクの頂点（0〜1 正規化・260623 クライアント要望）。
   * 指定時は x/y/width/height はこの多角形の外接矩形であり、実際の編集領域は多角形の内側。
   * 未指定（従来の矩形マスク）の場合は x/y/width/height がそのまま矩形領域。
   */
  points?: Array<{ x: number; y: number }>;
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
  /** コーディネートのスタイル参照画像（複数対応・260707 クライアント要望）。styleRefDataUrl は後方互換の先頭1枚。 */
  styleRefDataUrls?: string[];
  /** スタイル参照画像用の短い補足（任意） */
  styleMemo: string;
  objects: AiEditObjectReference[];
  /** この生成結果への良し悪し評価（good/bad）。プロジェクトに保存し、開き直しても表示を保つ（260707 クライアント要望）。 */
  feedback?: 'good' | 'bad';
}

/** AI画像編集由来の追加見積アイテム（3D未配置の仮項目） */
export interface AiEstimateItem {
  id: string;
  name: string;
  brand: string;
  price?: number;
  memo?: string;
  /** 品番/型番（任意・260619 クライアント要望）。 */
  modelNumber?: string;
  /** 商品ページの URL（任意・260619）。 */
  productUrl?: string;
}

/** AIエージェントへ渡す家具カタログ商品（推薦候補・Tier2 260620）。エージェントは番号(index)で参照する。 */
export interface AgentCatalogEntry {
  name: string;
  type: string;
  brand?: string;
  modelNumber?: string;
  price?: number;
  productUrl?: string;
}

/** AIエージェントの家具推薦（カタログ実データ＋推薦理由・Tier2）。「見積に追加」で AiEstimateItem 化する。 */
export interface AgentRecommendation {
  name: string;
  brand?: string;
  modelNumber?: string;
  price?: number;
  productUrl?: string;
  reason?: string;
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
