import type { Beam } from '../lib/project/projectState.js';
import { beamFootprintCornersMm } from './beamOverlap.js';

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

/**
 * 自由配置の梁（wallIndex 未定義）が、壁セグメントのクロス面を覆う帯の面積(m²)（3c-iii・260720 クライアント要望）。
 * 壁に沿って（ほぼ平行かつ近接して）置かれた自由梁は、室内側側面が梁仕上げとして別計上されるため、その裏のクロス面積を
 * 二重計上しないよう差し引く（壁梁 wallBeamWallCoverAreaM2 の自由梁版）。
 *
 * 座標系: 壁端点 p1Mm/p2Mm と 梁 cx/cy はいずれも「mm（sketch/SKETCH_BASE_SCALE=0.05）」で同一原点。
 *  - 近接: 梁フットプリントの壁法線範囲が壁線(s=0)から NEAR_TOL_MM 以内に触れていること。
 *  - 壁沿い: 法線方向の広がりが widthMm+TOL 以内（＝壁に斜め/直交な梁は「壁沿い」でないので対象外）。
 *  - 覆う長さ: フットプリントを壁方向へ射影し、壁セグメント [0, wallLen] にクリップ。
 *  - 鉛直: 梁帯 [top-H, top] と壁セグメント [segBottom, segTop] の重なり。
 * 壁梁(wallIndex 定義)・非有限・非正・重なり無しは 0。
 */
export function freeBeamWallCoverAreaM2(
  beam: Pick<Beam, 'cx' | 'cy' | 'lengthMm' | 'widthMm' | 'angleDeg' | 'heightMm' | 'wallIndex'> & { dropMm?: number },
  p1Mm: { x: number; y: number },
  p2Mm: { x: number; y: number },
  segBottomMm: number,
  segTopMm: number,
  roomHeightMm: number,
): number {
  if (beam.wallIndex !== undefined) return 0; // 壁梁は wallBeamWallCoverAreaM2 の担当
  const H = Number.isFinite(beam.heightMm) ? beam.heightMm : 0;
  const W = Number.isFinite(beam.widthMm) ? beam.widthMm : 0;
  if (H <= 0 || W <= 0 || !Number.isFinite(roomHeightMm)) return 0;
  const wx = p2Mm.x - p1Mm.x;
  const wy = p2Mm.y - p1Mm.y;
  const wallLen = Math.hypot(wx, wy);
  if (wallLen < 1e-6) return 0;
  const dx = wx / wallLen;
  const dy = wy / wallLen; // 壁方向 unit
  const nx = -dy;
  const ny = dx; // 壁法線 unit
  const corners = beamFootprintCornersMm(beam);
  let tmin = Infinity;
  let tmax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const c of corners) {
    const rx = c.x - p1Mm.x;
    const ry = c.y - p1Mm.y;
    const t = rx * dx + ry * dy; // 壁方向の位置(mm)
    const s = rx * nx + ry * ny; // 壁からの法線距離(mm・符号付き)
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  const NEAR_TOL_MM = 150; // 壁面から梁までの許容距離（壁厚・微小ずれ吸収）
  if (sMin > NEAR_TOL_MM || sMax < -NEAR_TOL_MM) return 0; // 壁から離れている
  if (sMax - sMin > W + NEAR_TOL_MM) return 0; // 壁に斜め/直交（法線方向に長く広がる）＝壁沿いでない
  const coveredLenMm = Math.min(tmax, wallLen) - Math.max(tmin, 0);
  if (coveredLenMm <= 0) return 0;
  const drop = Number.isFinite(beam.dropMm) ? (beam.dropMm as number) : 0;
  const beamTopMm = roomHeightMm - drop;
  const beamBottomMm = beamTopMm - H;
  const vOverlapMm = Math.min(segTopMm, beamTopMm) - Math.max(segBottomMm, beamBottomMm);
  if (vOverlapMm <= 0) return 0;
  return (coveredLenMm / 1000) * (vOverlapMm / 1000);
}
