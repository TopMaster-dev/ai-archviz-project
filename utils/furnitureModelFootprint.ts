import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { modelFormatOf, exoticNormalizeScale } from './modelFormat.js';
import { sanitizeGeometryScale } from './modelUnit.js';

/** 計測結果（mm）。height は寸法編集の高さ基準（260717）。 */
export interface GltfBaseDimsMm {
  width: number;
  depth: number;
  height: number;
}

/** 同一 (URL, unitScale) の同時ロードをマージ */
const urlPromises = new Map<string, Promise<GltfBaseDimsMm>>();

/** Box3 が空や異常なときの安全な既定値（mm） */
const FALLBACK_FOOTPRINT_MM = { width: 1000, depth: 700, height: 800 };
// 実寸取り込み（単位選択③）では小物（マグ/本/照明・実寸<200mm）〜大型まで扱うため、下限/上限を広く取る。
// sketchTransform の FOOTPRINT_MIN_MM/FOOTPRINT_MAX_MM と一致させ、計測値と 2D 足跡のクランプを揃える。
const MIN_FOOTPRINT_MM = 10;
const MAX_FOOTPRINT_MM = 50000;
/** 高さは薄い建具（カーテンレール等）から吹抜け照明まで幅広い。 */
const MIN_HEIGHT_MM = 10;
const MAX_HEIGHT_MM = 50000;

function sanitizeDimsMmFromMeters(x: number, z: number, y: number): GltfBaseDimsMm {
  const wx = Number.isFinite(x) ? x * 1000 : NaN;
  const dz = Number.isFinite(z) ? z * 1000 : NaN;
  const hy = Number.isFinite(y) ? y * 1000 : NaN;
  const height =
    Number.isFinite(hy) && hy > 0
      ? Math.min(MAX_HEIGHT_MM, Math.max(MIN_HEIGHT_MM, hy))
      : FALLBACK_FOOTPRINT_MM.height;
  if (!Number.isFinite(wx) || !Number.isFinite(dz) || wx <= 0 || dz <= 0) {
    return { ...FALLBACK_FOOTPRINT_MM, height };
  }
  return {
    width: Math.min(MAX_FOOTPRINT_MM, Math.max(MIN_FOOTPRINT_MM, wx)),
    depth: Math.min(MAX_FOOTPRINT_MM, Math.max(MIN_FOOTPRINT_MM, dz)),
    height
  };
}

/**
 * 3Dモデル（glTF/FBX/OBJ）のバウンディングを mm で返す。width/depth は床面投影（X/Z）、
 * height は Y（寸法編集の高さ基準・260717）。
 * GLTFCore と同様に clone 後に底面・XZ 中心合わせをしてから計測してもサイズは同じ。
 *
 * unitScale（③・260717）を渡すと、描画側 ClayModel と同一の幾何プリスケールを掛けてから計測する
 * （= 選択単位の実寸で footprint2d を出す）。unitScale 指定時は FBX/OBJ の exoticNormalizeScale
 * ヒューリスティクスは使わない（明示単位が優先）。未指定は従来挙動（glTFは無変換・FBX/OBJは正規化）。
 */
export function computeGltfFootprintBaseMm(
  modelUrl: string,
  unitScale?: number | null
): Promise<GltfBaseDimsMm> {
  const geomScale = sanitizeGeometryScale(unitScale);
  const cacheKey = `${modelUrl}|${geomScale ?? 'auto'}`;
  const existing = urlPromises.get(cacheKey);
  if (existing) return existing;

  const p = new Promise<GltfBaseDimsMm>((resolve, reject) => {
    // normalize=true（FBX/OBJ）のときは描画側 ClayModel と同じサイズ正規化を施してから計測し、
    // 2D フットプリントと 3D 描画のサイズを一致させる。unitScale 指定時は幾何プリスケールを優先適用する。
    const measureRoot = (root: THREE.Object3D, normalize: boolean) => {
      const clone = root.clone();
      if (geomScale != null) {
        clone.scale.multiplyScalar(geomScale);
      } else if (normalize) {
        const preBox = new THREE.Box3().setFromObject(clone);
        const sz = preBox.getSize(new THREE.Vector3());
        const s = exoticNormalizeScale(Math.max(sz.x, sz.y, sz.z));
        if (s !== 1) clone.scale.multiplyScalar(s);
      }
      const box = new THREE.Box3().setFromObject(clone);
      const size = box.getSize(new THREE.Vector3());
      resolve(sanitizeDimsMmFromMeters(size.x, size.z, size.y));
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

  urlPromises.set(cacheKey, p);
  return p;
}
