import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from './projectStore.js';
import type { FurnitureItem, Product } from '../../types.js';

function fakeFurniture(id: string): FurnitureItem {
  return {
    id,
    type: 'Chair',
    name: `chair-${id}`,
    modelUrl: '',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

const store = useProjectStore;

beforeEach(() => {
  store.getState().reset();
  store.temporal.getState().clear();
});

describe('projectStore — document actions', () => {
  it('adds and removes furniture', () => {
    store.getState().addFurniture(fakeFurniture('a'));
    expect(store.getState().scene.furniture).toHaveLength(1);
    store.getState().removeFurniture('a');
    expect(store.getState().scene.furniture).toHaveLength(0);
  });

  it('sets selections and material settings, and they are undoable', () => {
    const product = { id: 'p1' } as unknown as Product;
    store.getState().setSelections({ wall_1: product });
    expect(store.getState().materials.selections.wall_1?.id).toBe('p1');

    store.getState().setMaterialSettings({ p1: { roughness: 0.5, metalness: 0.1, textureScale: 2 } });
    expect(store.getState().materials.materialSettings.p1.textureScale).toBe(2);

    // 直前の materialSettings 変更を undo
    store.temporal.getState().undo();
    expect(store.getState().materials.materialSettings.p1).toBeUndefined();
    // selections は残る
    expect(store.getState().materials.selections.wall_1?.id).toBe('p1');
  });
});

describe('projectStore — undo / redo', () => {
  it('undoes and redoes furniture changes', () => {
    const { addFurniture } = store.getState();
    addFurniture(fakeFurniture('a'));
    addFurniture(fakeFurniture('b'));
    expect(store.getState().scene.furniture).toHaveLength(2);

    store.temporal.getState().undo();
    expect(store.getState().scene.furniture).toHaveLength(1);

    store.temporal.getState().redo();
    expect(store.getState().scene.furniture).toHaveLength(2);
  });

  it('does NOT record selection changes in undo history', () => {
    store.getState().addFurniture(fakeFurniture('a'));
    const before = store.temporal.getState().pastStates.length;
    store.getState().select(['a']);
    store.getState().toggleSelect('a');
    expect(store.temporal.getState().pastStates.length).toBe(before);
  });
});

describe('projectStore — grouping (Ctrl+G)', () => {
  it('groups >= 2 selected items and is undoable', () => {
    const s = store.getState();
    s.addFurniture(fakeFurniture('a'));
    s.addFurniture(fakeFurniture('b'));
    s.select(['a', 'b']);
    s.groupSelection('壁面ユニット');

    expect(store.getState().scene.groups).toHaveLength(1);
    expect(store.getState().scene.groups[0].memberIds).toEqual(['a', 'b']);

    store.temporal.getState().undo();
    expect(store.getState().scene.groups).toHaveLength(0);
  });

  it('does not group a single selection', () => {
    const s = store.getState();
    s.addFurniture(fakeFurniture('a'));
    s.select(['a']);
    s.groupSelection();
    expect(store.getState().scene.groups).toHaveLength(0);
  });

  it('drops a member from its group when the furniture is removed', () => {
    const s = store.getState();
    s.addFurniture(fakeFurniture('a'));
    s.addFurniture(fakeFurniture('b'));
    s.select(['a', 'b']);
    s.groupSelection();
    s.removeFurniture('a');
    // group had [a,b] -> now [b]; still present (>0 members)
    expect(store.getState().scene.groups[0].memberIds).toEqual(['b']);
  });
});

describe('projectStore — setFurniture bridge (App.tsx setState compat)', () => {
  it('replaces the array and prunes stale group members', () => {
    const s = store.getState();
    s.addFurniture(fakeFurniture('a'));
    s.addFurniture(fakeFurniture('b'));
    s.select(['a', 'b']);
    s.groupSelection();

    // App.tsx の setFurnitureItems(prev => prev.filter(...)) 相当: 'a' を除去
    s.setFurniture([fakeFurniture('b')]);

    expect(store.getState().scene.furniture.map((f) => f.id)).toEqual(['b']);
    expect(store.getState().scene.groups[0].memberIds).toEqual(['b']);
  });
});

describe('projectStore — beams', () => {
  it('sets beams and is undoable', () => {
    store.getState().setBeams([
      { id: 'b1', cx: 0, cy: 0, lengthMm: 3000, angleDeg: 0, widthMm: 150, dropMm: 200, heightMm: 300 },
    ]);
    expect(store.getState().scene.beams).toHaveLength(1);
    store.temporal.getState().undo();
    expect(store.getState().scene.beams).toHaveLength(0);
  });
});

describe('projectStore — load / serialize', () => {
  it('round-trips through toProjectState / loadProjectState', () => {
    store.getState().addFurniture(fakeFurniture('a'));
    store.getState().setRoomHeight(2700);
    const snapshot = store.getState().toProjectState();

    store.getState().reset();
    expect(store.getState().scene.furniture).toHaveLength(0);

    store.getState().loadProjectState(snapshot);
    expect(store.getState().scene.furniture).toHaveLength(1);
    expect(store.getState().scene.roomHeightMm).toBe(2700);
  });

  it('fills defaults when loading partial/legacy project data (no crash)', () => {
    // 旧スキーマ/部分的な data（scene.beams や aiEdit/camera が欠ける）を読み込んでも
    // 各フィールドが既定値で補完され、参照クラッシュしないこと。
    const partial = {
      sketch: { points: [{ x: 0, y: 0 }] },
      scene: { furniture: [fakeFurniture('a')] },
    };

    store.getState().loadProjectState(partial as never);
    const s = store.getState();
    expect(Array.isArray(s.scene.beams)).toBe(true);
    expect(Array.isArray(s.scene.furniture)).toBe(true);
    expect(s.scene.furniture).toHaveLength(1);
    expect(s.scene.roomHeightMm).toBeGreaterThan(0);
    expect(Array.isArray(s.sketch.points)).toBe(true);
    expect(s.sketch.openings).toBeDefined();
    expect(s.materials.selections).toBeDefined();
    expect(s.aiEdit.versions).toBeDefined();
    expect(s.camera.presets).toBeDefined();
  });

  it('loads the DB-default empty object without crashing', () => {
    store.getState().loadProjectState({} as never);
    const s = store.getState();
    expect(Array.isArray(s.scene.beams)).toBe(true);
    expect(Array.isArray(s.sketch.points)).toBe(true);
    expect(s.materials.materialSettings).toBeDefined();
  });

  it('sanitizes non-finite beam fields on load (prevents NaN 3D geometry crash)', () => {
    // 旧/壊れたデータ: widthMm/heightMm/dropMm が欠ける梁。NaN ジオメトリで3Dがクラッシュしないよう既定補完。
    store.getState().loadProjectState({
      scene: { beams: [{ id: 'bad', cx: 0, cy: 0, lengthMm: 1000, angleDeg: 0 }] },
    } as never);
    const b = store.getState().scene.beams[0];
    expect(b.widthMm).toBeGreaterThan(0);
    expect(b.heightMm).toBeGreaterThan(0);
    expect(Number.isFinite(b.dropMm)).toBe(true);
    expect(Number.isFinite(b.lengthMm) && b.lengthMm > 0).toBe(true);
  });
});
