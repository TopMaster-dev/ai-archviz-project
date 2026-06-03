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
