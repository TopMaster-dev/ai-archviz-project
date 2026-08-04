// 梁が「接している面」の側を、重なりを1回だけ数えて差し引く（260808 クライアント要望③）。
//
// 260728 の対応（utils/beamExposedArea.ts）で直したのは「梁そのものの表面積」だけだった。
// 梁の裏に隠れている天井面はまったく差し引かれておらず、天井は部屋の形そのままの面積で
// 計上され続けていた（6m×5m の天井に梁を格子状に5本入れると 4.16m² の過大計上）。
// 壁は 260613 から差し引いていたが、梁を1本ずつ順に引いているため、同じ帯に複数の梁が
// 重なると同じ面積を2回引いてしまっていた（今度は過小計上）。
//
// どちらも原因は同じで「梁ごとに足し引きしている＝和集合になっていない」こと。
// クライアントの言葉では「スケッチアップのプッシュ/プルのように、裏面を除外するロジック」。
// ここでは覆っている領域の和集合を厳密に求め、1回だけ差し引けるようにする。
//
// 単位: 入力 mm / 出力 m²。

import type { Beam } from '../lib/project/projectState.js';
import { beamFootprintCornersMm } from './beamOverlap.js';
import { areaOfPolyMinusUnion, convexIntersectionPolygon, type Pt } from './beamExposedArea.js';
import { triangulatePolygon } from './polygonTriangulate.js';
import { unionAreaOfRects, type Rect } from './rectUnion.js';

/** 天井に接しているとみなす下がりの許容値(mm)。 */
const CEILING_CONTACT_EPS_MM = 1e-6;

/**
 * 梁が天井に密着しているか（＝天井面がその梁の裏に隠れるか）。
 *
 * 下がり(dropMm)があると梁の上面と天井の間にすき間ができ、天井面は見えたままになる。
 * その場合は天井から差し引かない（クライアント確認済み・260808）。
 * beamExposedAreaByIdM2 が「下がり>0 なら梁の上面は露出」としているのと同じ判定で、
 * 両者が食い違うと天井と梁の両方から同じ面が消える／二重に残ることになる。
 */
export function beamTouchesCeiling(beam: Pick<Beam, 'dropMm'>): boolean {
  const drop = Number.isFinite(beam.dropMm) ? beam.dropMm : 0;
  return drop <= CEILING_CONTACT_EPS_MM;
}

function isUsableBeam(b: Pick<Beam, 'lengthMm' | 'widthMm' | 'cx' | 'cy'>): boolean {
  return (
    Number.isFinite(b.lengthMm) &&
    b.lengthMm > 0 &&
    Number.isFinite(b.widthMm) &&
    b.widthMm > 0 &&
    Number.isFinite(b.cx) &&
    Number.isFinite(b.cy)
  );
}

/**
 * 天井が梁に覆われている面積(m²)。重なりは1回だけ数える。
 *
 * 天井の請求面積は「部屋の面積 − この値」になる。梁が交差していても、
 * 交差部分を2回引かないことが肝心（クライアント指摘の「梁が重なった部分」）。
 *
 * 必ず部屋の内側だけを数えること。自由梁は室内へ制限されておらず（クリックやX/Y入力で
 * 部屋の外にも置ける）、footprint をそのまま引くと、天井に掛かっていない梁で
 * 天井面積が減ってしまう。部屋はL字などの凹多角形になり得るので三角形へ分けてから交差を取る。
 *
 * @param roomPointsMm 部屋の輪郭(mm)。空・3頂点未満なら控除しない（0を返す）。
 */
export function beamCeilingCoverM2(beams: readonly Beam[], roomPointsMm: readonly Pt[]): number {
  if (!beams || beams.length === 0) return 0;
  const polys: Pt[][] = [];
  for (const b of beams) {
    if (!b || !isUsableBeam(b) || !beamTouchesCeiling(b)) continue;
    polys.push(beamFootprintCornersMm(b));
  }
  if (polys.length === 0) return 0;

  const triangles = triangulatePolygon(roomPointsMm ?? []);
  if (triangles.length === 0) return 0; // 部屋の形が取れないなら控除しない（安全側＝従来どおり全面計上）

  // 互いに素な分解: i 番目は「自分から 0..i-1 の和集合を引いた残り」だけ持つ。
  // 三角形ごとに切ってから足すので、合計は「部屋 ∩ 梁の和集合」の面積に厳密に一致する。
  let mm2 = 0;
  for (const tri of triangles) {
    for (let i = 0; i < polys.length; i++) {
      const piece = convexIntersectionPolygon(tri, polys[i]); // 凸∩凸＝凸
      if (piece.length < 3) continue;
      mm2 += areaOfPolyMinusUnion(piece, polys.slice(0, i));
    }
  }
  return Math.max(0, mm2) / 1e6;
}

/** 梁の鉛直帯 [bottom, top]（mm）。 */
function beamBand(beam: Pick<Beam, 'heightMm'> & { dropMm?: number }, roomHeightMm: number) {
  const h = Number.isFinite(beam.heightMm) ? beam.heightMm : 0;
  const drop = Number.isFinite(beam.dropMm) ? (beam.dropMm as number) : 0;
  const top = roomHeightMm - drop;
  return { top, bottom: top - h, h };
}

/**
 * 壁梁が壁区画を覆う帯。壁に沿った距離 s(mm) × 高さ y(mm) の矩形。
 * 面積は beamArea.ts の wallBeamWallCoverAreaM2 と一致する（そちらは1本ぶんの面積だけを返し、
 * 重なりを扱えないため、こちらへ移行する）。
 */
export function wallBeamCoverStrip(
  beam: Pick<Beam, 'lengthMm' | 'heightMm' | 'wallIndex'> & { dropMm?: number },
  segBottomMm: number,
  segTopMm: number,
  roomHeightMm: number,
): Rect | null {
  if (beam.wallIndex === undefined) return null;
  const L = Number.isFinite(beam.lengthMm) ? beam.lengthMm : 0;
  const { top, bottom, h } = beamBand(beam, roomHeightMm);
  if (!(L > 0) || !(h > 0) || !Number.isFinite(roomHeightMm)) return null;
  const y0 = Math.max(segBottomMm, bottom);
  const y1 = Math.min(segTopMm, top);
  if (!(y1 > y0)) return null;
  return { x0: 0, x1: L, y0, y1 };
}

/**
 * 壁沿いに置かれた自由梁が壁区画を覆う帯（3c-iii の自由梁版）。
 * 判定条件は beamArea.ts の freeBeamWallCoverAreaM2 と同一に保つこと
 * （近接150mm以内・壁に対して斜め/直交でない・壁区画へクリップ）。
 */
export function freeBeamCoverStrip(
  beam: Pick<Beam, 'cx' | 'cy' | 'lengthMm' | 'widthMm' | 'angleDeg' | 'heightMm' | 'wallIndex'> & { dropMm?: number },
  p1Mm: { x: number; y: number },
  p2Mm: { x: number; y: number },
  segBottomMm: number,
  segTopMm: number,
  roomHeightMm: number,
): Rect | null {
  if (beam.wallIndex !== undefined) return null; // 壁梁は wallBeamCoverStrip の担当
  const W = Number.isFinite(beam.widthMm) ? beam.widthMm : 0;
  const { top, bottom, h } = beamBand(beam, roomHeightMm);
  if (!(h > 0) || !(W > 0) || !Number.isFinite(roomHeightMm)) return null;

  const wx = p2Mm.x - p1Mm.x;
  const wy = p2Mm.y - p1Mm.y;
  const wallLen = Math.hypot(wx, wy);
  if (wallLen < 1e-6) return null;
  const dx = wx / wallLen;
  const dy = wy / wallLen;
  const nx = -dy;
  const ny = dx;

  const corners = beamFootprintCornersMm(beam);
  let tmin = Infinity;
  let tmax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const c of corners) {
    const rx = c.x - p1Mm.x;
    const ry = c.y - p1Mm.y;
    const t = rx * dx + ry * dy;
    const s = rx * nx + ry * ny;
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  const NEAR_TOL_MM = 150;
  if (sMin > NEAR_TOL_MM || sMax < -NEAR_TOL_MM) return null; // 壁から離れている
  if (sMax - sMin > W + NEAR_TOL_MM) return null; // 壁沿いでない（斜め/直交）

  const x0 = Math.max(tmin, 0);
  const x1 = Math.min(tmax, wallLen);
  if (!(x1 > x0)) return null;
  const y0 = Math.max(segBottomMm, bottom);
  const y1 = Math.min(segTopMm, top);
  if (!(y1 > y0)) return null;
  return { x0, x1, y0, y1 };
}

/**
 * 壁の1区画に対して、梁が覆っている帯の和集合の面積(m²)。
 *
 * 帯は壁に沿った距離 s と高さ y の矩形なので、和集合は unionAreaOfRects で厳密に出せる
 * （梁の表面積計算で側面の埋没を求めているのと同じ考え方）。
 * 梁ごとに足し合わせると、同じ帯を複数の梁が覆っているときに二重に差し引いてしまう。
 */
export function wallBeamCoverUnionM2(strips: readonly (Rect | null)[]): number {
  if (!strips || strips.length === 0) return 0;
  const valid: Rect[] = [];
  for (const r of strips) {
    if (!r) continue;
    if (!Number.isFinite(r.x0) || !Number.isFinite(r.x1) || !Number.isFinite(r.y0) || !Number.isFinite(r.y1)) continue;
    if (!(r.x1 > r.x0) || !(r.y1 > r.y0)) continue;
    valid.push(r);
  }
  if (valid.length === 0) return 0;
  return Math.max(0, unionAreaOfRects(valid)) / 1e6;
}
