import type {
  Point,
  Opening,
  FurnitureItem,
  Product,
  CameraPreset,
  AiEditVersion,
  AiEditObjectReference,
  AiEstimateItem,
} from '../../types.js';

// プロジェクトの統合状態（projects.data jsonb に永続化する「正」の形）。
// 既存 App.tsx の分散 state を集約する受け皿。状態リファクタ（Zustand 化）で本接続する。

export const PROJECT_SCHEMA_VERSION = 1;

/** 2D スケッチ背景の下絵（PDF/画像）。フェーズ1の下絵挿入機能用。 */
export interface UnderlaySettings {
  /** 画像 data URL（PDF は 1 ページ目をラスタライズして格納） */
  dataUrl: string;
  opacity: number;
  /** 実寸合わせ用の基準（mm/px）。未設定可。 */
  scaleMmPerPx?: number;
  offsetX: number;
  offsetY: number;
  visible: boolean;
  /** PDF の 1px あたりの用紙上のmm（縮尺1:1）。PDF挿入時に算出。縮尺(1:denom)適用時 scaleMmPerPx = paperMmPerPx×denom（#5a・260715）。 */
  paperMmPerPx?: number;
  /** PDF図面の縮尺の分母（1:denom）。未設定=手動幅指定。 */
  scaleDenominator?: number;
}

/**
 * マテリアルの表示設定（productId ごと）。App.tsx の materialSettings と同形。
 * 同一製品を複数サーフェスで使う場合に設定を共有するため productId をキーに保持する。
 */
export interface MaterialSettingsValue {
  roughness: number;
  metalness: number;
  textureScale?: number;
  /** テクスチャの向き（度）。3Dの貼り付け回転に使用（260613・管理表 row 164「テクスチャ向き変更」）。未設定=0。 */
  textureRotation?: number;
  baseboardEnabled?: boolean;
  baseboardHeight?: number;
  baseboardColor?: string;
  /** 巾木の m 単価（円/m）。見積の巾木ラインで「壁延長 × 単価」に使用（260613）。未設定=0。 */
  baseboardUnitPrice?: number;
  wainscotHeight?: number;
  doorColor?: string;
  doorFrameColor?: string;
  windowFrameColor?: string;
}

/** オブジェクトのグループ（Ctrl+G）。memberIds は家具等のオブジェクト id。 */
export interface Group {
  id: string;
  label?: string;
  memberIds: string[];
}

/**
 * 梁（パラメトリックな2D要素・フェーズ1）。中心＋長さ＋角度で保持し、寸法を数値編集できる。
 * dropMm/heightMm は3D（天井下の梁せい）用。
 */
export interface Beam {
  id: string;
  cx: number; // 中心 X (mm)
  cy: number; // 中心 Y (mm)
  lengthMm: number;
  angleDeg: number;
  widthMm: number;
  dropMm: number; // 天井からの下がり (mm)
  heightMm: number; // 梁せい (mm)
  /** 壁に乗る梁: 壁（線分）のインデックス。設定時は cx/cy/長さ/角度を壁から導出し、壁の移動に追従する。
   *  undefined のときは自由配置の梁（cx/cy/長さ/角度を直接編集）。 */
  wallIndex?: number;
}

/** プロジェクト種別（2a）。'full' = 空間デザイン（2D/3D エディタ）。'photo' = 写真アップロード→AI画像編集だけ。 */
export type ProjectKind = 'full' | 'photo';

export interface ProjectState {
  schemaVersion: number;
  /** プロジェクト種別。既定 'full'。'photo' は写真AI編集専用（2a）。 */
  kind: ProjectKind;
  sketch: {
    points: Point[];
    openings: Opening[];
    /** 壁インデックス → 分割数（2 素材の貼り分け）。App.tsx と同じく数値キー。 */
    wallDivisions: Record<number, number>;
    /** 下絵（平面図用）。旧 `underlay` 単一フィールドはここへ移行。 */
    underlayPlan: UnderlaySettings | null;
    /** 下絵（天伏図用）。 */
    underlayCeiling: UnderlaySettings | null;
    /** グリッドの基準点（原点）。mm。未設定/null=ワールド原点(0,0)。#5（260715）: 任意位置に設定可。 */
    gridOrigin?: { x: number; y: number } | null;
  };
  scene: {
    roomHeightMm: number;
    furniture: FurnitureItem[];
    groups: Group[];
    beams: Beam[];
  };
  /** マテリアル: selections（メッシュ名→製品）＋ materialSettings（productId→設定） */
  materials: {
    selections: Record<string, Product | null>;
    materialSettings: Record<string, MaterialSettingsValue>;
  };
  aiEdit: {
    versions: AiEditVersion[];
    activeVersionId: string | null;
    draftObjects: AiEditObjectReference[];
  };
  camera: {
    presets: CameraPreset[];
    /** 3Dレンダリング比率（'16:9' 等・第2段 260703）。3Dビュー表示比率・AIレンダ比率・書き出しに連動。未指定は '16:9'。 */
    renderAspectRatio?: string;
  };
  /** 概算見積の手動「AI追加アイテム」（3D未配置の見積行）。永続化対象（260619 クライアント要望）。 */
  estimate: {
    aiItems: AiEstimateItem[];
  };
}

export function createEmptyProjectState(): ProjectState {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    kind: 'full',
    sketch: { points: [], openings: [], wallDivisions: {}, underlayPlan: null, underlayCeiling: null, gridOrigin: null },
    scene: { roomHeightMm: 2400, furniture: [], groups: [], beams: [] },
    materials: { selections: {}, materialSettings: {} },
    aiEdit: { versions: [], activeVersionId: null, draftObjects: [] },
    camera: { presets: [], renderAspectRatio: '16:9' },
    estimate: { aiItems: [] },
  };
}
