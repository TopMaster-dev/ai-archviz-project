/**
 * 梁（beam）の複数選択トグル（260715 クライアント #7a:「梁の複数選択でマテリアル一括貼り＝壁と同様」）。
 *
 * 素材の一括適用は activeMeshes（選択メッシュ名の集合）に載っている全メッシュへ handleProductSelect が
 * ファンアウトする既存の仕組みをそのまま使う。梁も `Beam_<id>` を activeMeshes に複数載せれば一括適用できる。
 * この純関数は Shift クリックのトグル結果（梁メッシュ集合＋プライマリ梁 id）を、App と RoomViewer の両方で
 * 同一ロジックで求めるために切り出したもの（プライマリ梁はギズモ／プロパティ編集の対象＝最後に触れた梁）。
 */

const BEAM_PREFIX = 'Beam_';

export interface BeamToggleResult {
  /** トグル後の梁メッシュ名集合（`Beam_<id>` の配列・非梁メッシュは含めない）。 */
  nextBeamMeshes: string[];
  /** トグル後のプライマリ梁 id（ギズモ／プロパティ編集の対象）。全解除時は null。 */
  nextPrimary: string | null;
}

/**
 * activeMeshes（壁など非梁も混在しうる）から梁メッシュだけを取り出し、beamId をトグルする。
 *  - 未選択なら末尾に追加し、その梁をプライマリにする。
 *  - 選択済みなら外し、残った梁の末尾を新しいプライマリにする（無ければ null）。
 * 非梁メッシュは戻り値に含めない（梁の複数選択は梁のみを対象にする＝壁選択とは排他）。
 */
export function toggleBeamSelection(activeMeshes: string[], beamId: string): BeamToggleResult {
  const key = `${BEAM_PREFIX}${beamId}`;
  const beamKeys = activeMeshes.filter((m) => m.startsWith(BEAM_PREFIX));
  const has = beamKeys.includes(key);
  const nextBeamMeshes = has ? beamKeys.filter((m) => m !== key) : [...beamKeys, key];
  const nextPrimary = has
    ? nextBeamMeshes.length
      ? nextBeamMeshes[nextBeamMeshes.length - 1].slice(BEAM_PREFIX.length)
      : null
    : beamId;
  return { nextBeamMeshes, nextPrimary };
}
