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
});
