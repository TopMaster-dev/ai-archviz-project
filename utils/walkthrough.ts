import * as THREE from 'three';

/** 水平前方向（Y=0）— カメラ前進に使用 */
export function walkForward(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
}

export function walkRight(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
}

/** ワールド方向（XZ）からヨー */
export function horizontalYawFromDirectionXZ(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** yaw/pitch から視線方向（正規化） */
export function lookDirection(yaw: number, pitch: number): THREE.Vector3 {
  const cp = Math.cos(pitch);
  return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
}

export function clampPitch(pitch: number, limit: number): number {
  return THREE.MathUtils.clamp(pitch, -limit, limit);
}

export type WalkBoundsAabb = { minX: number; maxX: number; minZ: number; maxZ: number };

export function getAabbFromMPoints(mPoints: { x: number; z: number }[]): WalkBoundsAabb | null {
  if (!mPoints.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of mPoints) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

export function clampXZToAabb(
  x: number,
  z: number,
  aabb: WalkBoundsAabb,
  margin: number
): [number, number] {
  return [
    THREE.MathUtils.clamp(x, aabb.minX + margin, aabb.maxX - margin),
    THREE.MathUtils.clamp(z, aabb.minZ + margin, aabb.maxZ - margin),
  ];
}

/** XZ平面で点 p から線分 ab への最近点と距離²。 */
function closestOnSegmentXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): { x: number; z: number; d2: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx;
  const z = az + t * dz;
  const ddx = px - x;
  const ddz = pz - z;
  return { x, z, d2: ddx * ddx + ddz * ddz };
}

/** XZ平面でのポリゴン内外判定（レイキャスティング）。 */
export function pointInPolygonXZ(
  px: number,
  pz: number,
  poly: { x: number; z: number }[]
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const zi = poly[i].z;
    const xj = poly[j].x;
    const zj = poly[j].z;
    const intersect = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * カメラの XZ を「部屋ポリゴンの内側（壁から margin 以上）」へクランプする（260624）。
 * 外接矩形（AABB）ではなく実際の壁ポリゴンに沿って閉じ込めるので、L 字など非矩形の部屋で
 * 外接矩形からへこんだ壁をすり抜けて外へ出てしまう不具合（ウォークで1枚の壁だけ通り抜ける）を防ぐ。
 * - 内側かつ最寄り壁から margin 以上離れていればそのまま。
 * - 外側、または壁に近すぎる場合は、最寄りエッジの内向き法線方向へ margin だけ押し戻す。
 */
export function clampXZToPolygon(
  x: number,
  z: number,
  poly: { x: number; z: number }[],
  margin: number
): [number, number] {
  if (poly.length < 3) return [x, z];
  let bcx = x;
  let bcz = z;
  let bd2 = Infinity;
  let bax = 0;
  let baz = 0;
  let bbx = 0;
  let bbz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x;
    const az = poly[j].z;
    const bx = poly[i].x;
    const bz = poly[i].z;
    const r = closestOnSegmentXZ(x, z, ax, az, bx, bz);
    if (r.d2 < bd2) {
      bd2 = r.d2;
      bcx = r.x;
      bcz = r.z;
      bax = ax;
      baz = az;
      bbx = bx;
      bbz = bz;
    }
  }
  const inside = pointInPolygonXZ(x, z, poly);
  if (inside && Math.sqrt(bd2) >= margin) return [x, z];
  // 最寄りエッジの法線（単位）。内向きになる符号を内外判定で選ぶ。
  let nx = -(bbz - baz);
  let nz = bbx - bax;
  const nlen = Math.hypot(nx, nz) || 1;
  nx /= nlen;
  nz /= nlen;
  const probe = 0.02;
  if (!pointInPolygonXZ(bcx + nx * probe, bcz + nz * probe, poly)) {
    nx = -nx;
    nz = -nz;
  }
  return [bcx + nx * margin, bcz + nz * margin];
}
