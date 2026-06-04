import type {
  Point,
  Opening,
  FurnitureItem,
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

/** マテリアル割り当て（サーフェスID → 製品 + 表示設定）。 */
export interface MaterialAssignment {
  productId: string;
  /** ツヤ・テクスチャスケール等の調整値 */
  settings?: Record<string, number>;
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
    /** 壁インデックス → 分割位置（2 素材の貼り分け） */
    wallDivisions: Record<string, number>;
    underlay: UnderlaySettings | null;
  };
  scene: {
    roomHeightMm: number;
    furniture: FurnitureItem[];
    groups: Group[];
  };
  /** サーフェスID（メッシュ名）→ マテリアル割り当て */
  materials: Record<string, MaterialAssignment>;
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
    materials: {},
    aiEdit: { versions: [], activeVersionId: null, draftObjects: [] },
    camera: { presets: [] },
  };
}
