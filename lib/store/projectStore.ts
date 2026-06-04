import { create } from 'zustand';
import { temporal } from 'zundo';
import { immer } from 'zustand/middleware/immer';
import type { FurnitureItem, Point, Opening } from '../../types.js';
import {
  createEmptyProjectState,
  PROJECT_SCHEMA_VERSION,
  type ProjectState,
  type MaterialAssignment,
  type UnderlaySettings,
} from '../project/projectState.js';

// プロジェクトの統合ストア（Zustand + immer）。
// Undo/Redo は zundo の temporal ミドルウェアで実現し、履歴に乗せるのは「ドキュメント」
// （sketch / scene / materials）のみ。選択状態などの一時 UI はパーシャライズで除外する。
// これにより、選択操作で Undo 履歴が汚れず、重い aiEdit 画像も履歴に含めない。

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id_${Math.random().toString(36).slice(2)}`;
}

export interface ProjectStoreState {
  // --- ドキュメント（Undo 対象） ---
  sketch: ProjectState['sketch'];
  scene: ProjectState['scene'];
  materials: ProjectState['materials'];
  // --- Undo 対象外 ---
  aiEdit: ProjectState['aiEdit'];
  camera: ProjectState['camera'];
  /** 選択中オブジェクト id（一時状態・履歴対象外） */
  selectedIds: string[];

  // sketch
  setSketchPoints(points: Point[]): void;
  setOpenings(openings: Opening[]): void;
  setUnderlay(underlay: UnderlaySettings | null): void;

  // scene / furniture
  setRoomHeight(mm: number): void;
  /** 家具配列を丸ごと置き換える（App.tsx の setState 互換ブリッジ用）。groups も整合させる。 */
  setFurniture(items: FurnitureItem[]): void;
  addFurniture(item: FurnitureItem): void;
  updateFurniture(id: string, patch: Partial<FurnitureItem>): void;
  removeFurniture(id: string): void;

  // materials
  assignMaterial(surfaceId: string, assignment: MaterialAssignment): void;
  clearMaterial(surfaceId: string): void;

  // selection (transient)
  select(ids: string[]): void;
  toggleSelect(id: string): void;
  clearSelection(): void;

  // grouping (Ctrl+G)
  groupSelection(label?: string): void;
  ungroup(groupId: string): void;

  // load / replace
  loadProjectState(state: ProjectState): void;
  reset(): void;
  toProjectState(): ProjectState;
}

const initial = createEmptyProjectState();

export const useProjectStore = create<ProjectStoreState>()(
  temporal(
    immer((set, get) => ({
      sketch: initial.sketch,
      scene: initial.scene,
      materials: initial.materials,
      aiEdit: initial.aiEdit,
      camera: initial.camera,
      selectedIds: [],

      setSketchPoints: (points) =>
        set((s) => {
          s.sketch.points = points;
        }),
      setOpenings: (openings) =>
        set((s) => {
          s.sketch.openings = openings;
        }),
      setUnderlay: (underlay) =>
        set((s) => {
          s.sketch.underlay = underlay;
        }),

      setRoomHeight: (mm) =>
        set((s) => {
          s.scene.roomHeightMm = mm;
        }),
      setFurniture: (items) =>
        set((s) => {
          s.scene.furniture = items;
          // 置き換え後に存在しない id をグループから除去し、空グループを掃除する。
          const ids = new Set(items.map((f) => f.id));
          for (const g of s.scene.groups) g.memberIds = g.memberIds.filter((m) => ids.has(m));
          s.scene.groups = s.scene.groups.filter((g) => g.memberIds.length > 0);
        }),
      addFurniture: (item) =>
        set((s) => {
          s.scene.furniture.push(item);
        }),
      updateFurniture: (id, patch) =>
        set((s) => {
          const f = s.scene.furniture.find((x) => x.id === id);
          if (f) Object.assign(f, patch);
        }),
      removeFurniture: (id) =>
        set((s) => {
          s.scene.furniture = s.scene.furniture.filter((x) => x.id !== id);
          for (const g of s.scene.groups) g.memberIds = g.memberIds.filter((m) => m !== id);
          s.scene.groups = s.scene.groups.filter((g) => g.memberIds.length > 0);
          s.selectedIds = s.selectedIds.filter((x) => x !== id);
        }),

      assignMaterial: (surfaceId, assignment) =>
        set((s) => {
          s.materials[surfaceId] = assignment;
        }),
      clearMaterial: (surfaceId) =>
        set((s) => {
          delete s.materials[surfaceId];
        }),

      select: (ids) =>
        set((s) => {
          s.selectedIds = ids;
        }),
      toggleSelect: (id) =>
        set((s) => {
          s.selectedIds = s.selectedIds.includes(id)
            ? s.selectedIds.filter((x) => x !== id)
            : [...s.selectedIds, id];
        }),
      clearSelection: () =>
        set((s) => {
          s.selectedIds = [];
        }),

      groupSelection: (label) =>
        set((s) => {
          const ids = s.selectedIds.filter((id) => s.scene.furniture.some((f) => f.id === id));
          if (ids.length < 2) return;
          s.scene.groups.push({ id: genId(), label, memberIds: [...ids] });
        }),
      ungroup: (groupId) =>
        set((s) => {
          s.scene.groups = s.scene.groups.filter((g) => g.id !== groupId);
        }),

      loadProjectState: (state) =>
        set((s) => {
          s.sketch = state.sketch;
          s.scene = state.scene;
          s.materials = state.materials;
          s.aiEdit = state.aiEdit;
          s.camera = state.camera;
          s.selectedIds = [];
        }),
      reset: () =>
        set((s) => {
          const e = createEmptyProjectState();
          s.sketch = e.sketch;
          s.scene = e.scene;
          s.materials = e.materials;
          s.aiEdit = e.aiEdit;
          s.camera = e.camera;
          s.selectedIds = [];
        }),
      toProjectState: () => {
        const s = get();
        return {
          schemaVersion: PROJECT_SCHEMA_VERSION,
          sketch: s.sketch,
          scene: s.scene,
          materials: s.materials,
          aiEdit: s.aiEdit,
          camera: s.camera,
        };
      },
    })),
    {
      limit: 100,
      // 履歴に乗せるのはドキュメントのみ（選択・aiEdit・camera は除外）。
      partialize: (s) => ({ sketch: s.sketch, scene: s.scene, materials: s.materials }),
      // immer は不変更新時に参照を保つため、参照比較で no-op / 選択のみ変更を履歴から除外。
      equality: (a, b) => a.sketch === b.sketch && a.scene === b.scene && a.materials === b.materials,
    },
  ),
);

/** Undo/Redo 制御（zundo temporal ストア）。 */
export const temporalStore = useProjectStore.temporal;
