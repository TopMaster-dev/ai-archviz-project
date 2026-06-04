import type {
  Point,
  Opening,
  FurnitureItem,
  Product,
  CameraPreset,
  AiEditVersion,
  AiEditObjectReference,
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
}

/**
 * マテリアルの表示設定（productId ごと）。App.tsx の materialSettings と同形。
 * 同一製品を複数サーフェスで使う場合に設定を共有するため productId をキーに保持する。
 */
export interface MaterialSettingsValue {
  roughness: number;
  metalness: number;
  textureScale?: number;
  baseboardEnabled?: boolean;
  baseboardHeight?: number;
  baseboardColor?: string;
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

export interface ProjectState {
  schemaVersion: number;
  sketch: {
    points: Point[];
    openings: Opening[];
    /** 壁インデックス → 分割数（2 素材の貼り分け）。App.tsx と同じく数値キー。 */
    wallDivisions: Record<number, number>;
    underlay: UnderlaySettings | null;
  };
  scene: {
    roomHeightMm: number;
    furniture: FurnitureItem[];
    groups: Group[];
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
  };
}

export function createEmptyProjectState(): ProjectState {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sketch: { points: [], openings: [], wallDivisions: {}, underlay: null },
    scene: { roomHeightMm: 2400, furniture: [], groups: [] },
    materials: { selections: {}, materialSettings: {} },
    aiEdit: { versions: [], activeVersionId: null, draftObjects: [] },
    camera: { presets: [] },
  };
}
