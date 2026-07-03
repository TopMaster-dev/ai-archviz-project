import type { FurnitureItem } from '../types.js';

/**
 * 家具の移動/回転パッチの適用（2D/3D共通ロジック・純関数でテスト可能）。
 *
 * 260703 クライアント報告「3Dでグループ化しても一緒に動かない」対応の中核。
 * - 移動（rotation 未指定）かつ「一緒に動かす集合」(moveMembers) が2件以上で対象を含むときは、
 *   対象と同じ差分(dx,dz)で集合の全メンバーを平行移動する。
 * - 回転（rotation 指定）はドラッグ対象のみに適用する（グループ全体の回転はしない）。
 *
 * 重要: 呼び出し側は「移動時は rotation を渡さない（undefined）」こと。回転値を常に渡すと groupMove が
 * 常に false になり、対象しか動かない（今回の不具合の原因）。
 */
export function applyFurniturePatch(
  prev: FurnitureItem[],
  id: string,
  position: [number, number, number],
  rotation: [number, number, number] | undefined,
  moveMembers: Set<string>
): FurnitureItem[] {
  const target = prev.find((f) => f.id === id);
  const groupMove = !!target && !rotation && moveMembers.size > 1 && moveMembers.has(id);
  const dx = target ? position[0] - target.position[0] : 0;
  const dz = target ? position[2] - target.position[2] : 0;
  return prev.map((f) => {
    if (f.id === id) return { ...f, position, ...(rotation ? { rotation } : {}) };
    if (groupMove && moveMembers.has(f.id)) {
      return {
        ...f,
        position: [f.position[0] + dx, f.position[1], f.position[2] + dz] as [number, number, number],
      };
    }
    return f;
  });
}

/**
 * ドラッグ対象 id の「一緒に動かす集合」を求める。
 * 所属グループ（メンバー2件以上）のメンバー ∪ 現在の複数選択(selectedIds)。
 * グループ由来を優先しつつ選択も併合するので、選択のミクロなタイミングに依存せず確実に一緒に動く。
 */
export function resolveMoveMembers(
  id: string,
  groups: ReadonlyArray<{ memberIds: string[] }>,
  selectedIds: readonly string[]
): Set<string> {
  const set = new Set<string>(selectedIds);
  set.add(id); // ドラッグ対象は必ず含む
  const group = groups.find((g) => g.memberIds.includes(id));
  if (group && group.memberIds.length > 1) for (const m of group.memberIds) set.add(m);
  return set;
}

export interface Vec2XZ {
  x: number;
  z: number;
}

/** メンバー position(XZ) の平均（重心）。メンバー不在は null。 */
export function computeGroupCentroidXZ(
  items: ReadonlyArray<FurnitureItem>,
  memberIds: Set<string>
): Vec2XZ | null {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const f of items) {
    if (!memberIds.has(f.id)) continue;
    sx += f.position[0];
    sz += f.position[2];
    n++;
  }
  return n === 0 ? null : { x: sx / n, z: sz / n };
}

/**
 * グループ回転（2D/3D共通・純関数）。260703 クライアント要望「グループを一括で回転」。
 * centroidXZ を軸に memberIds 全員を XZ 平面で dTheta 回し、各メンバーの yaw(rotation[1]) にも dTheta を加算する。
 * Y は保持。memberIds 外は不変。dTheta は 3D yaw 系（RoomViewer の単体回転 atan2(dx,dz)＋yaw += delta と一致）:
 *   x' = cx + dx·cos + dz·sin
 *   z' = cz − dx·sin + dz·cos     （符号は 3D 単体回転と一致・検証済み）
 * memberIds.size < 2 または dTheta === 0 は no-op（参照そのまま返す）。
 */
export function applyGroupRotation(
  prev: FurnitureItem[],
  memberIds: Set<string>,
  centroidXZ: Vec2XZ,
  dTheta: number
): FurnitureItem[] {
  if (dTheta === 0 || memberIds.size < 2) return prev;
  const cos = Math.cos(dTheta);
  const sin = Math.sin(dTheta);
  return prev.map((f) => {
    if (!memberIds.has(f.id)) return f;
    const dx = f.position[0] - centroidXZ.x;
    const dz = f.position[2] - centroidXZ.z;
    const nx = centroidXZ.x + dx * cos + dz * sin;
    const nz = centroidXZ.z - dx * sin + dz * cos;
    return {
      ...f,
      position: [nx, f.position[1], nz] as [number, number, number],
      rotation: [f.rotation[0], (f.rotation[1] || 0) + dTheta, f.rotation[2]] as [number, number, number],
    };
  });
}
