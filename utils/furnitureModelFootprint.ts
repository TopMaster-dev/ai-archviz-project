import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { modelFormatOf, exoticNormalizeScale } from './modelFormat.js';

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
 * 3Dモデル（glTF/FBX/OBJ）の水平バウンディング（ローカル X / Z）を mm で返す。Y は床面投影に使わない。
 * GLTFCore と同様に clone 後に底面・XZ 中心合わせをしてから計測してもサイズは同じ。
 */
export function computeGltfFootprintBaseMm(modelUrl: string): Promise<{ width: number; depth: number }> {
  const existing = urlPromises.get(modelUrl);
  if (existing) return existing;

  const p = new Promise<{ width: number; depth: number }>((resolve, reject) => {
    // normalize=true（FBX/OBJ）のときは描画側 ClayModel と同じサイズ正規化を施してから計測し、
    // 2D フットプリントと 3D 描画のサイズを一致させる。
    const measureRoot = (root: THREE.Object3D, normalize: boolean) => {
      const clone = root.clone();
      if (normalize) {
        const preBox = new THREE.Box3().setFromObject(clone);
        const sz = preBox.getSize(new THREE.Vector3());
        const s = exoticNormalizeScale(Math.max(sz.x, sz.y, sz.z));
        if (s !== 1) clone.scale.multiplyScalar(s);
      }
      const box = new THREE.Box3().setFromObject(clone);
      const size = box.getSize(new THREE.Vector3());
      resolve(sanitizeFootprintMmFromMeters(size.x, size.z));
    };
    const onErr = (err: unknown) => reject(err ?? new Error('model load failed'));
    const fmt = modelFormatOf(modelUrl);
    if (fmt === 'fbx') {
      new FBXLoader().load(modelUrl, (group) => measureRoot(group, true), undefined, onErr);
    } else if (fmt === 'obj') {
      new OBJLoader().load(modelUrl, (group) => measureRoot(group, true), undefined, onErr);
    } else {
      new GLTFLoader().load(modelUrl, (gltf) => measureRoot(gltf.scene, false), undefined, onErr);
    }
  });

  urlPromises.set(modelUrl, p);
  return p;
}
