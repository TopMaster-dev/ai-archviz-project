import { describe, it, expect } from 'vitest';
import { applyFurniturePatch, resolveMoveMembers, applyGroupRotation, computeGroupCentroidXZ } from './furnitureGroupMove.js';
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

describe('computeGroupCentroidXZ / applyGroupRotation (グループ回転・共通・260703)', () => {
  it('centroid = メンバー position 平均（XZ）', () => {
    const prev = [item('a', 0, 0), item('b', 2, 0), item('c', 1, 2)];
    expect(computeGroupCentroidXZ(prev, new Set(['a', 'b']))).toEqual({ x: 1, z: 0 });
    expect(computeGroupCentroidXZ(prev, new Set())).toBeNull();
  });

  it('90°回転: orbit と yaw が 3D 単体回転と同符号（符号ゲート）', () => {
    // centroid(0,0), a=(dx=1,dz=0) → φ=atan2(1,0)=+π/2; +π/2 で φ→π ⇒ (dx,dz)=(0,-1)
    const prev = [item('a', 1, 0), item('b', -1, 0)];
    const next = applyGroupRotation(prev, new Set(['a', 'b']), { x: 0, z: 0 }, Math.PI / 2);
    const a = next.find((f) => f.id === 'a')!;
    expect(a.position[0]).toBeCloseTo(0);
    expect(a.position[2]).toBeCloseTo(-1); // ← 3D form。+1 が出たら helper の符号が逆＝実機と不一致
    expect(a.rotation[1]).toBeCloseTo(Math.PI / 2);
    const b = next.find((f) => f.id === 'b')!;
    // 剛体（メンバー間距離が保存される）。
    expect(Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2])).toBeCloseTo(2);
  });

  it('Y（高さ）保持・非メンバー不変', () => {
    const prev = [
      { ...item('a', 1, 0), position: [1, 0.7, 0] as [number, number, number] },
      item('b', -1, 0),
      item('z', 9, 9),
    ];
    const next = applyGroupRotation(prev, new Set(['a', 'b']), { x: 0, z: 0 }, Math.PI / 2);
    expect(next.find((f) => f.id === 'a')!.position[1]).toBeCloseTo(0.7);
    expect(next.find((f) => f.id === 'z')!.position).toEqual([9, 0, 9]);
  });

  it('size<2（単一）は no-op（同一参照）', () => {
    const single = [item('a', 1, 0)];
    expect(applyGroupRotation(single, new Set(['a']), { x: 0, z: 0 }, 1)).toBe(single);
  });

  it('dTheta=0 は入力配列の同一参照を返す', () => {
    const prev = [item('a', 1, 0), item('b', -1, 0)];
    expect(applyGroupRotation(prev, new Set(['a', 'b']), { x: 0, z: 0 }, 0)).toBe(prev);
  });
});
