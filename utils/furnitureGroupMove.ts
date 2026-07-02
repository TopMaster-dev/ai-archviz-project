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
