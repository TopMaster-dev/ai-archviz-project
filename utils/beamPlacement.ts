import type { Beam } from '../lib/project/projectState.js';

/**
 * 壁梁の「実際に描かれる位置」を、現在の部屋形状から導く（260728 #10 の配線用）。
 *
 * 壁梁は cx/cy に**壁セグメントの中点（＝壁の芯）**が保存されているだけで、3D では描画時に
 * 室内側へ widthMm/2 だけオフセットして置かれる（components/RoomViewer.tsx の同ロジック）。
 * 見積側が保存値をそのまま使うと、
 *   ・梁が壁線をまたいだ位置にあることになり、他の梁との重なり判定が実際とズレる
 *   ・壁を後から動かしても梁が「昔の壁の位置」に residual として残る
 * という二重のズレが出る（260728 敵対検証で計測: 交差控除が約半分になる）。
 *
 * そこで見積計算の直前に、描画と同じ規則で cx/cy/lengthMm/angleDeg を作り直す。
 * 自由梁（wallIndex 未定義）は保存値がそのまま真実なので何もしない。
 *
 * @param pointsMm 部屋ポリゴンの頂点（mm）。sketchPoints を /0.05 したもの。
 * @param centerMm 室内側を判定するための内部点（重心で十分）。
 */
export function resolveBeamPlacement<T extends Beam>(
  beam: T,
  pointsMm: { x: number; y: number }[],
  centerMm: { x: number; y: number } | null,
): T {
  if (beam.wallIndex === undefined) return beam; // 自由梁は保存値が真実
  const n = pointsMm.length;
  if (!centerMm || n < 2) return beam;
  const p1 = pointsMm[beam.wallIndex % n];
  const p2 = pointsMm[(beam.wallIndex + 1) % n];
  if (!p1 || !p2) return beam;
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!(len > 0)) return beam;

  let cx = (p1.x + p2.x) / 2;
  let cy = (p1.y + p2.y) / 2;
  const angleDeg = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
  // 壁法線のうち室内を向く側へ、梁の幅の半分だけ寄せる（＝梁の外面がちょうど壁線に乗る）。
  let nx = -(p2.y - p1.y) / len;
  let ny = (p2.x - p1.x) / len;
  if (nx * (centerMm.x - cx) + ny * (centerMm.y - cy) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const w = Number.isFinite(beam.widthMm) ? beam.widthMm : 0;
  cx += nx * (w / 2);
  cy += ny * (w / 2);
  return { ...beam, cx, cy, lengthMm: len, angleDeg };
}

/** 部屋ポリゴンの重心（室内側判定用）。頂点が足りなければ null。 */
export function polygonCentroidMm(pointsMm: { x: number; y: number }[]): { x: number; y: number } | null {
  if (!pointsMm || pointsMm.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pointsMm) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / pointsMm.length, y: sy / pointsMm.length };
}
