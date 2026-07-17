import * as THREE from 'three';

// 3Dモデルの取り込み向き（①・260717 クライアント要望）。
//  - 上下（modelUprightXDeg）: X軸まわり 0/90/180/270°。寝ている/上下逆のモデルを立てる補正。
//    ジオメトリに焼き込む（描画 ClayModel と計測 computeGltfFootprintBaseMm で同一適用）ため、footprint(W/D/H)も正しくなる。
//  - 前後（forwardYawDeg・既存）: Y軸まわりのヨー。配置時の rotation[1] に入る（2D/3D共通の既存経路）。
//  - 壁側面の自動推定: 最大面積の平らな縦面（＝背面）を検出し、その面が背面(-Z)に向くヨーを提案する。

/** 上下補正は 90°刻み（軸整合で footprint の軸入替が単純・計測と描画が一致しやすい）。 */
export function normalizeUprightXDeg(v: unknown): 0 | 90 | 180 | 270 {
  const n = typeof v === 'number' && Number.isFinite(v) ? ((Math.round(v / 90) * 90) % 360 + 360) % 360 : 0;
  return (n === 90 || n === 180 || n === 270 ? n : 0) as 0 | 90 | 180 | 270;
}

/** ヨーを 0/90/180/270 に丸める（自動推定は 90°刻みで提案）。 */
export function normalizeYawDeg(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return ((Math.round(v / 90) * 90) % 360 + 360) % 360;
}

// -Z（背面/壁側）へ「その方向の縦面」を向けるためのヨー（THREE の makeRotationY 規約で検証済み）。
const YAW_TO_BACK: Record<'px' | 'nx' | 'pz' | 'nz', number> = { nz: 0, pz: 180, px: 90, nx: 270 };

/**
 * 最大面積の平らな縦面（背面と推定）を検出し、その面が背面(-Z)へ向くヨー（度・0/90/180/270）を返す。
 * uprightXDeg を与えると、その上下補正を適用した姿勢で判定する（縦面が変わるため）。
 * 三角形の法線を ±X/±Z にビニングして面積を合計し、最大方向を背面法線とみなす。
 * 縦面が見つからない（球体など）ときは 0 を返す（＝提案なし相当）。
 */
export function detectWallFaceYawDeg(root: THREE.Object3D, uprightXDeg = 0): number {
  root.updateWorldMatrix(true, true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const upright = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(normalizeUprightXDeg(uprightXDeg)));

  const area = { px: 0, nx: 0, pz: 0, nz: 0 };
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  root.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !geo || !geo.attributes?.position) return;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    // root ローカル座標へ戻し、その上に上下補正をかけた行列で頂点を評価する。
    const toLocal = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);
    const m = new THREE.Matrix4().multiplyMatrices(upright, toLocal);
    const index = geo.index;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      vA.fromBufferAttribute(pos, i0).applyMatrix4(m);
      vB.fromBufferAttribute(pos, i1).applyMatrix4(m);
      vC.fromBufferAttribute(pos, i2).applyMatrix4(m);
      ab.subVectors(vB, vA);
      ac.subVectors(vC, vA);
      nrm.crossVectors(ab, ac);
      const a = 0.5 * nrm.length();
      if (!(a > 0)) continue;
      nrm.normalize();
      if (Math.abs(nrm.y) > 0.5) continue; // 上下面（天板/底面）は縦面でないので除外
      if (Math.abs(nrm.x) >= Math.abs(nrm.z)) {
        if (nrm.x >= 0) area.px += a;
        else area.nx += a;
      } else {
        if (nrm.z >= 0) area.pz += a;
        else area.nz += a;
      }
    }
  });

  let bestKey: 'px' | 'nx' | 'pz' | 'nz' = 'nz';
  let bestArea = -1;
  (['px', 'nx', 'pz', 'nz'] as const).forEach((k) => {
    if (area[k] > bestArea) {
      bestArea = area[k];
      bestKey = k;
    }
  });
  if (!(bestArea > 0)) return 0;
  return YAW_TO_BACK[bestKey];
}
