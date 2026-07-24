import { useMemo, type ReactElement } from 'react';
import * as THREE from 'three';
import { useLoader } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { Object3D } from 'three';
import { modelFormatOf, type ModelFormat } from '../utils/modelFormat.js';

/**
 * FBX/OBJ が生む MeshPhong/MeshLambert マテリアルを、GLB と同じ物理ベース MeshStandardMaterial へ置換する（260724・クライアント要望①）。
 * 背景: three r182 ではテクスチャの色空間(sRGB)は各ローダで統一済みだが、シーンの主光源が Environment(IBL)のため、
 * IBL の拡散光は PBR(MeshStandard) にしか届かず、Phong/Lambext(FBX/OBJ) は暗く見える。標準マテリアル化で GLB と明るさを揃える。
 * マップ/色/法線などは引き継ぐ。userData フラグで冪等（同一ルートの再変換はしない）。GLB(GltfRoot)には適用しない。
 */
function standardizeMaterials(root: Object3D): Object3D {
  const ud = root.userData as { __matStandardized?: boolean };
  if (ud.__matStandardized) return root;
  ud.__matStandardized = true;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.material) return;
    // 法線が無いジオメトリ（OBJ 等）は MeshStandard で真っ黒になるため補完。
    if (mesh.geometry && !mesh.geometry.attributes?.normal) mesh.geometry.computeVertexNormals();
    const convertOne = (m: THREE.Material): THREE.Material => {
      const p = m as unknown as {
        isMeshPhongMaterial?: boolean;
        isMeshLambertMaterial?: boolean;
        map?: THREE.Texture | null;
        color?: THREE.Color;
        normalMap?: THREE.Texture | null;
        normalScale?: THREE.Vector2;
        aoMap?: THREE.Texture | null;
        bumpMap?: THREE.Texture | null;
        bumpScale?: number;
        emissive?: THREE.Color;
        emissiveMap?: THREE.Texture | null;
        emissiveIntensity?: number;
        alphaMap?: THREE.Texture | null;
        transparent?: boolean;
        opacity?: number;
        alphaTest?: number;
        side?: THREE.Side;
        vertexColors?: boolean;
        flatShading?: boolean;
        name?: string;
      };
      if (!p.isMeshPhongMaterial && !p.isMeshLambertMaterial) return m; // Standard/Basic はそのまま
      const std = new THREE.MeshStandardMaterial({
        map: p.map ?? null,
        color: p.color ? p.color.clone() : new THREE.Color(0xffffff),
        normalMap: p.normalMap ?? null,
        aoMap: p.aoMap ?? null,
        bumpMap: p.bumpMap ?? null,
        bumpScale: p.bumpScale ?? 1,
        emissive: p.emissive ? p.emissive.clone() : new THREE.Color(0x000000),
        emissiveMap: p.emissiveMap ?? null,
        emissiveIntensity: p.emissiveIntensity ?? 1,
        alphaMap: p.alphaMap ?? null,
        transparent: p.transparent ?? false,
        opacity: p.opacity ?? 1,
        alphaTest: p.alphaTest ?? 0,
        side: p.side ?? THREE.FrontSide,
        vertexColors: p.vertexColors ?? false,
        flatShading: p.flatShading ?? false,
        roughness: 0.8, // FBX/OBJ に PBR 値は無いので中庸な既定（明るさは IBL で GLB と揃う）
        metalness: 0.0,
      });
      if (p.normalScale) std.normalScale.copy(p.normalScale);
      std.name = p.name ?? '';
      m.dispose(); // 旧 Phong を破棄（このルート専用参照なので安全）
      return std;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convertOne) : convertOne(mesh.material);
  });
  return root;
}

// 3Dモデル（.glb/.gltf/.fbx/.obj）を読み込み、読み込んだルート Object3D を children（描画関数）へ渡す。
// 形式ごとに使うローダ hook が異なる（useGLTF / useLoader(FBXLoader) / useLoader(OBJLoader)）ため、
// hooks 規則を守るべく形式ごとに別コンポーネントへ分岐し、各コンポーネントは常に 1 つだけ hook を呼ぶ。
// 既存の glTF 経路（drei の draco/meshopt 設定込み）は useGLTF のまま変更しない（後方互換）。
// children には形式も渡す（FBX/OBJ は単位がまちまちで、描画側でサイズ正規化が必要なため）。

type RootRenderer = (root: Object3D, format: ModelFormat | null) => ReactElement | null;
type SingleRenderer = (root: Object3D) => ReactElement | null;

function GltfRoot({ url, children }: { url: string; children: SingleRenderer }) {
  const { scene } = useGLTF(url);
  return children(scene);
}

function FbxRoot({ url, children }: { url: string; children: SingleRenderer }) {
  const root = useLoader(FBXLoader, url);
  const std = useMemo(() => standardizeMaterials(root), [root]);
  return children(std);
}

function ObjRoot({ url, children }: { url: string; children: SingleRenderer }) {
  const root = useLoader(OBJLoader, url);
  const std = useMemo(() => standardizeMaterials(root), [root]);
  return children(std);
}

/**
 * 形式に応じたローダで 3Dモデルを読み込み、ルート Object3D と形式を children に渡す。
 * ローダはサスペンドするため、呼び出し側は <Suspense>（必要なら ErrorBoundary）で包むこと。
 */
export function ModelRoot({ url, children }: { url: string; children: RootRenderer }) {
  const fmt = modelFormatOf(url);
  if (fmt === 'fbx') return <FbxRoot url={url}>{(o) => children(o, 'fbx')}</FbxRoot>;
  if (fmt === 'obj') return <ObjRoot url={url}>{(o) => children(o, 'obj')}</ObjRoot>;
  return <GltfRoot url={url}>{(o) => children(o, fmt)}</GltfRoot>;
}
