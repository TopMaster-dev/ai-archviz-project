import { describe, it, expect } from 'vitest';
import { applyFurniturePatch, resolveMoveMembers } from './furnitureGroupMove.js';
import type { FurnitureItem } from '../types.js';

const item = (id: string, x: number, z: number): FurnitureItem => ({
  id,
  type: 't',
  name: id,
  modelUrl: '',
  position: [x, 0, z],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

describe('applyFurniturePatch (グループ/複数選択の一緒移動・260703)', () => {
  it('移動(rotation未指定)＋メンバー2件以上: 対象と同じ差分で全員が平行移動する', () => {
    const prev = [item('a', 0, 0), item('b', 2, 2), item('c', 5, 5)];
    const next = applyFurniturePatch(prev, 'a', [1, 0, 3], undefined, new Set(['a', 'b']));
    expect(next.find((f) => f.id === 'a')!.position).toEqual([1, 0, 3]); // 対象は新位置
    expect(next.find((f) => f.id === 'b')!.position).toEqual([3, 0, 5]); // +dx=1,+dz=3
    expect(next.find((f) => f.id === 'c')!.position).toEqual([5, 0, 5]); // 非メンバーは不変
  });

  it('回転(rotation指定)は対象のみに適用し、グループ移動はしない', () => {
    const prev = [item('a', 0, 0), item('b', 2, 2)];
    const next = applyFurniturePatch(prev, 'a', [0, 0, 0], [0, 1.5, 0], new Set(['a', 'b']));
    expect(next.find((f) => f.id === 'a')!.rotation).toEqual([0, 1.5, 0]);
    expect(next.find((f) => f.id === 'b')!.position).toEqual([2, 0, 2]); // b は動かない
  });

  it('単一(メンバー1件)は対象のみ移動', () => {
    const prev = [item('a', 0, 0), item('b', 2, 2)];
    const next = applyFurniturePatch(prev, 'a', [1, 0, 1], undefined, new Set(['a']));
    expect(next.find((f) => f.id === 'a')!.position).toEqual([1, 0, 1]);
    expect(next.find((f) => f.id === 'b')!.position).toEqual([2, 0, 2]);
  });

  it('Y(高さ)はメンバー側で保持され、XZのみ差分移動', () => {
    const prev = [{ ...item('a', 0, 0), position: [0, 1, 0] as [number, number, number] }, { ...item('b', 4, 4), position: [4, 3, 4] as [number, number, number] }];
    const next = applyFurniturePatch(prev, 'a', [2, 1, 2], undefined, new Set(['a', 'b']));
    expect(next.find((f) => f.id === 'b')!.position).toEqual([6, 3, 6]); // Y=3 保持、XZ +2
  });
});

describe('resolveMoveMembers (所属グループ ∪ 複数選択)', () => {
  const groups = [{ memberIds: ['a', 'b'] }, { memberIds: ['x'] }];
  it('グループ(2件以上)所属なら選択が崩れていてもメンバー全員を返す', () => {
    expect(resolveMoveMembers('a', groups, ['a'])).toEqual(new Set(['a', 'b']));
  });
  it('未グループなら selectedIds ∪ 対象', () => {
    expect(resolveMoveMembers('c', groups, ['c', 'd'])).toEqual(new Set(['c', 'd']));
    expect(resolveMoveMembers('c', groups, [])).toEqual(new Set(['c']));
  });
  it('グループ＋別途選択はユニオン（混在選択も一緒に動く）', () => {
    expect(resolveMoveMembers('a', groups, ['a', 'd'])).toEqual(new Set(['a', 'b', 'd']));
  });
  it('メンバー1件のグループは単独扱い（グループ移動しない）', () => {
    expect(resolveMoveMembers('x', groups, ['x'])).toEqual(new Set(['x']));
  });
});
