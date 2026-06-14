import type { Beam } from '../lib/project/projectState.js';

/**
 * 梁の露出表面積(m²)を返す（見積の数量算出用）。
 *
 * クライアント要望（260611 #2a）:「壁・天井・床に接していない面だけを計上する」
 *  （見積・仕上げ材変更の対象となる露出面の面積）。
 *  - 上面（L×W）: 天井に接していれば除外。梁が天井から下がっている(dropMm>0)ときは露出。
 *  - 下面（L×W）: 床に接していれば除外。ceilingHeightMm 指定時、梁下端が床(=0)以下に
 *      達していれば接触とみなす。未指定時は床に達しないものとして露出扱い（安全側）。
 *  - 長辺側面（L×H）: 壁梁は壁に接する片面を除外して1面、自由梁は2面。
 *  - 端面（W×H）: 壁梁は両端が隅で隣接壁に接するとみなし除外(0面)、自由梁は2面。
 *
 * L=lengthMm, W=widthMm, H=heightMm（mm→m）。非有限/非正は 0 を返す。
 * @param ceilingHeightMm 天井高(mm)。床への接触判定に使用（任意）。
 */
export function beamExposedAreaM2(
  beam: Pick<Beam, 'lengthMm' | 'widthMm' | 'heightMm' | 'wallIndex'> & { dropMm?: number },
  ceilingHeightMm?: number,
): number {
  const L = (Number.isFinite(beam.lengthMm) ? beam.lengthMm : 0) / 1000;
  const W = (Number.isFinite(beam.widthMm) ? beam.widthMm : 0) / 1000;
  const H = (Number.isFinite(beam.heightMm) ? beam.heightMm : 0) / 1000;
  if (L <= 0 || W <= 0 || H <= 0) return 0;

  const isWallBeam = beam.wallIndex !== undefined;
  const drop = Number.isFinite(beam.dropMm) ? (beam.dropMm as number) : 0;

  // 上面: 天井から下がっていれば露出。フラッシュ(drop=0)なら天井接触で除外。
  const topExposed = drop > 0;
  // 下面: 天井高が与えられ、梁下端が床面(0)以下なら床接触で除外。
  const heightMm = Number.isFinite(beam.heightMm) ? (beam.heightMm as number) : 0;
  const bottomReachesFloor =
    Number.isFinite(ceilingHeightMm) && (ceilingHeightMm as number) - drop - heightMm <= 1e-6;
  const bottomExposed = !bottomReachesFloor;

  // 長辺側面: 壁梁=1面、自由梁=2面。端面: 壁梁=0面（隅で隣接壁に接触）、自由梁=2面。
  const sideFaces = isWallBeam ? 1 : 2;
  const endFaces = isWallBeam ? 0 : 2;

  let area = 0;
  if (topExposed) area += L * W;
  if (bottomExposed) area += L * W;
  area += sideFaces * (L * H);
  area += endFaces * (W * H);
  return area;
}

/**
 * 壁梁が壁面（クロス）を覆う帯の面積(m²)。壁梁の鉛直帯
 * [roomHeight - drop - height, roomHeight - drop] と、指定した壁セグメント
 * [segBottomMm, segTopMm] の重なり高さ × 梁の長さ。
 *
 * クライアント要望（260613）:「梁がある部分も壁面（クロス）の計算に含まれている」の修正。
 * 壁梁の室内側側面は梁の仕上げとして別計上されるため、その裏のクロス面積は二重計上になる。
 * 壁梁(wallIndex 定義)のみ対象。自由梁・非有限・非正・重なり無しは 0。
 */
export function wallBeamWallCoverAreaM2(
  beam: Pick<Beam, 'lengthMm' | 'heightMm' | 'wallIndex'> & { dropMm?: number },
  segBottomMm: number,
  segTopMm: number,
  roomHeightMm: number,
): number {
  if (beam.wallIndex === undefined) return 0;
  const L = (Number.isFinite(beam.lengthMm) ? beam.lengthMm : 0) / 1000;
  const H = Number.isFinite(beam.heightMm) ? beam.heightMm : 0;
  if (L <= 0 || H <= 0 || !Number.isFinite(roomHeightMm)) return 0;
  const drop = Number.isFinite(beam.dropMm) ? (beam.dropMm as number) : 0;
  const beamTopMm = roomHeightMm - drop;
  const beamBottomMm = beamTopMm - H;
  const overlapMm = Math.min(segTopMm, beamTopMm) - Math.max(segBottomMm, beamBottomMm);
  if (overlapMm <= 0) return 0;
  return (overlapMm / 1000) * L;
}
