import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** 同一 URL の同時ロードをマージ */
const urlPromises = new Map<string, Promise<{ width: number; depth: number }>>();

/** Box3 が空や異常なときの安全な既定値（mm） */
const FALLBACK_FOOTPRINT_MM = { width: 1000, depth: 700 };
const MIN_FOOTPRINT_MM = 200;
const MAX_FOOTPRINT_MM = 10000;

function sanitizeFootprintMmFromMeters(x: number, z: number): { width: number; depth: number } {
  const wx = Number.isFinite(x) ? x * 1000 : NaN;
  const dz = Number.isFinite(z) ? z * 1000 : NaN;
  if (!Number.isFinite(wx) || !Number.isFinite(dz) || wx <= 0 || dz <= 0) {
    return { ...FALLBACK_FOOTPRINT_MM };
  }
  return {
    width: Math.min(MAX_FOOTPRINT_MM, Math.max(MIN_FOOTPRINT_MM, wx)),
    depth: Math.min(MAX_FOOTPRINT_MM, Math.max(MIN_FOOTPRINT_MM, dz))
  };
}

/**
 * GLTF の水平バウンディング（ローカル X / Z）を mm で返す。Y は床面投影に使わない。
 * GLTFCore と同様に clone 後に底面・XZ 中心合わせをしてから計測してもサイズは同じ。
 */
export function computeGltfFootprintBaseMm(modelUrl: string): Promise<{ width: number; depth: number }> {
  const existing = urlPromises.get(modelUrl);
  if (existing) return existing;

  const p = new Promise<{ width: number; depth: number }>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      modelUrl,
      (gltf) => {
        const clone = gltf.scene.clone();
        const box = new THREE.Box3().setFromObject(clone);
        const size = box.getSize(new THREE.Vector3());
        resolve(sanitizeFootprintMmFromMeters(size.x, size.z));
      },
      undefined,
      (err) => reject(err ?? new Error('GLTF load failed'))
    );
  });

  urlPromises.set(modelUrl, p);
  return p;
}
