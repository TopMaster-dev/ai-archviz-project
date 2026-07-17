import type { Beam } from '../lib/project/projectState.js';

// 梁同士が重なる部分の面積を見積から除外する（260717 クライアント要望）。
// 梁の露出面積 beamExposedAreaM2 は各梁を独立に計上するため、2本の梁が交差すると
// 水平面（上面/下面 L×W）の重なり領域が両方の梁で二重計上される。
// ここでは各梁の床投影（回転矩形）の交差面積を求め、鉛直方向に相互貫入している
// （＝同じ高さ帯で交差している）ペアについて、双方が露出している水平面の分だけ控除する。
// 積み重なり（鉛直帯が重ならない）ペアは別々の露出面なので控除しない。

interface Pt {
  x: number;
  y: number;
}

/** 梁の床投影（回転矩形）の四隅(mm)。cx/cy 中心・angleDeg 軸方向・幅は軸に直交。 */
export function beamFootprintCornersMm(
  beam: Pick<Beam, 'cx' | 'cy' | 'lengthMm' | 'angleDeg' | 'widthMm'>
): Pt[] {
  const rad = (beam.angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad); // 長さ方向
  const px = -uy;
  const py = ux; // 幅方向（直交）
  const hl = beam.lengthMm / 2;
  const hw = beam.widthMm / 2;
  return [
    { x: beam.cx + ux * hl + px * hw, y: beam.cy + uy * hl + py * hw },
    { x: beam.cx + ux * hl - px * hw, y: beam.cy + uy * hl - py * hw },
    { x: beam.cx - ux * hl - px * hw, y: beam.cy - uy * hl - py * hw },
    { x: beam.cx - ux * hl + px * hw, y: beam.cy - uy * hl + py * hw }
  ];
}

function signedAreaMm2(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** 反時計回り（CCW）に正規化する（Sutherland–Hodgman の内側判定を一貫させるため）。 */
function ensureCCW(poly: Pt[]): Pt[] {
  return signedAreaMm2(poly) < 0 ? [...poly].reverse() : poly;
}

/** 線分 PQ と直線 AB の交点（Sutherland–Hodgman 用・平行なら Q を返す安全側）。 */
function segmentLineIntersect(P: Pt, Q: Pt, A: Pt, B: Pt): Pt {
  const dx = Q.x - P.x;
  const dy = Q.y - P.y;
  const ex = B.x - A.x;
  const ey = B.y - A.y;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return Q;
  const t = ((A.x - P.x) * ey - (A.y - P.y) * ex) / denom;
  return { x: P.x + t * dx, y: P.y + t * dy };
}

/**
 * 2つの凸多角形（梁の回転矩形）の交差面積(mm²)。Sutherland–Hodgman で subject を clip で切り、面積を出す。
 * 交差なしは 0。
 */
export function convexIntersectionAreaMm2(a: Pt[], b: Pt[]): number {
  if (a.length < 3 || b.length < 3) return 0;
  let output = ensureCCW(a);
  const clip = ensureCCW(b);
  for (let i = 0; i < clip.length; i++) {
    const A = clip[i];
    const B = clip[(i + 1) % clip.length];
    const ex = B.x - A.x;
    const ey = B.y - A.y;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const P = input[j];
      const Q = input[(j + 1) % input.length];
      // CCW の clip 辺 AB に対し、点が左側（内側）なら cross >= 0。
      const insideP = ex * (P.y - A.y) - ey * (P.x - A.x) >= 0;
      const insideQ = ex * (Q.y - A.y) - ey * (Q.x - A.x) >= 0;
      if (insideP) output.push(P);
      if (insideP !== insideQ) output.push(segmentLineIntersect(P, Q, A, B));
    }
    if (output.length === 0) return 0;
  }
  return Math.abs(signedAreaMm2(output));
}

function beamVerticalBand(
  beam: Pick<Beam, 'dropMm' | 'heightMm'>,
  roomHeightMm: number
): { top: number; bottom: number } {
  const drop = Number.isFinite(beam.dropMm) ? beam.dropMm : 0;
  const h = Number.isFinite(beam.heightMm) ? beam.heightMm : 0;
  const top = roomHeightMm - drop;
  return { top, bottom: top - h };
}

/** beamExposedAreaM2 と同じ判定：上面は下がり有りで露出、下面は床に達しなければ露出。 */
function beamFacesExposed(
  beam: Pick<Beam, 'dropMm' | 'heightMm'>,
  roomHeightMm: number
): { topExposed: boolean; bottomExposed: boolean } {
  const drop = Number.isFinite(beam.dropMm) ? beam.dropMm : 0;
  const h = Number.isFinite(beam.heightMm) ? beam.heightMm : 0;
  const topExposed = drop > 0;
  const bottomReachesFloor = Number.isFinite(roomHeightMm) && roomHeightMm - drop - h <= 1e-6;
  return { topExposed, bottomExposed: !bottomReachesFloor };
}

/**
 * 梁ごとの重なり控除面積(m²)を返す（beamExposedAreaM2 から差し引く用）。
 * 交差ペアの二重計上分を 50/50 で両梁に割り当てる（合計は正しく、行ごとの偏りを避ける）。
 */
export function beamOverlapDeductionByIdM2(
  beams: Beam[],
  roomHeightMm: number
): Map<string, number> {
  const ded = new Map<string, number>();
  const valid = beams.filter(
    (b) =>
      Number.isFinite(b.lengthMm) &&
      b.lengthMm > 0 &&
      Number.isFinite(b.widthMm) &&
      b.widthMm > 0 &&
      Number.isFinite(b.cx) &&
      Number.isFinite(b.cy)
  );
  if (valid.length < 2) return ded;
  const corners = valid.map((b) => beamFootprintCornersMm(b));
  const bands = valid.map((b) => beamVerticalBand(b, roomHeightMm));
  const faces = valid.map((b) => beamFacesExposed(b, roomHeightMm));

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      // 鉛直方向に相互貫入している（＝同じ高さ帯で交差する）ペアのみ二重計上が起きる。
      const lo = Math.max(bands[i].bottom, bands[j].bottom);
      const hi = Math.min(bands[i].top, bands[j].top);
      if (hi - lo <= 1e-6) continue;

      const areaMm2 = convexIntersectionAreaMm2(corners[i], corners[j]);
      if (!(areaMm2 > 0)) continue;
      const overlapM2 = areaMm2 / 1e6;

      let sharedFaces = 0;
      if (faces[i].topExposed && faces[j].topExposed) sharedFaces += 1;
      if (faces[i].bottomExposed && faces[j].bottomExposed) sharedFaces += 1;
      if (sharedFaces === 0) continue;

      const half = (overlapM2 * sharedFaces) / 2;
      ded.set(valid[i].id, (ded.get(valid[i].id) ?? 0) + half);
      ded.set(valid[j].id, (ded.get(valid[j].id) ?? 0) + half);
    }
  }
  return ded;
}
