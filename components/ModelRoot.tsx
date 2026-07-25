import { useMemo, type ReactElement } from 'react';
import * as THREE from 'three';
import { useLoader } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { Object3D } from 'three';
import { modelFormatOf, type ModelFormat } from '../utils/modelFormat.js';

// FBX/OBJ 変換時に用いる PBR スカラー既定（Phong/Lambert には PBR 値が無いため）。GLB/GLTF には掛けない。
const NORMALIZE_ROUGHNESS = 0.8;
const NORMALIZE_METALNESS = 0.0;

/**
 * MeshStandardMaterial を全形式（GLB/GLTF/FBX/OBJ）で同じ見え方に近づける「正規化」（260725・クライアント要望①）。
 * 目的: 同一モデルを FBX と GLB で読み込んでも、ほぼ同じ明るさ・質感に見え、テクスチャが暗く/くすまないようにする。
 *   - ベースカラーテクスチャ(map)がある場合は color を白(1,1,1)へ固定＝baseColorFactor の色かぶりで
 *     テクスチャが暗く/くすむのを防ぐ（glTF は baseColorFactor×baseColorTexture の乗算のため、非白 factor で暗くなる）。
 *   - アルベド/発光マップの色空間を sRGB に統一（各ローダの解釈差を吸収）。
 *   - テクスチャの無い単色マテリアルは color をそのまま使う（client 要件: 単色は崩さない）。
 *   - PBR スカラー(metalness/roughness)の FBX 基準への統一は resetPbrScalars=true のときだけ行う＝FBX/OBJ 専用。
 *     GLB/GLTF は作者が設定した金属/光沢を保持する（下記 normalizeGltfMaterials は false で呼ぶ）。
 * 各マテリアルの userData フラグで冪等（drei キャッシュ共有シーンでも二重適用しない）。
 *
 * @param resetPbrScalars PBR スカラー(metalness=0/roughness=0.8)へ寄せるか。FBX/OBJ 変換時のみ true。
 *   【重要・260725 敵対レビュー指摘】glTF は金属/光沢を metalnessMap 無しのスカラーで持つのが大半のため、
 *   GLB に一律で metalness=0/roughness=0.8 を掛けると、意図した金属（例: 椅子の金属脚）が平板なプラスチックに
 *   潰れて実写的な見えが悪化する（IBL 環境では作者値のままで正しく反射する）。よって GLB では上書きしない。
 */
function normalizeStandardMaterial(mat: THREE.Material, resetPbrScalars = false): void {
  const m = mat as THREE.MeshStandardMaterial;
  if (!(m as unknown as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) return;
  const ud = m.userData as { __ariseMatNormalized?: boolean };
  if (ud.__ariseMatNormalized) return;
  ud.__ariseMatNormalized = true;
  if (m.map) {
    // テクスチャ有り＝color(baseColorFactor)の色かぶりを打ち消して白に（暗く/くすむのを防ぐ）。
    m.color.setRGB(1, 1, 1);
    m.map.colorSpace = THREE.SRGBColorSpace;
    m.map.needsUpdate = true;
  }
  if (m.emissiveMap) {
    m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
    m.emissiveMap.needsUpdate = true;
  }
  // PBR スカラー統一は FBX/OBJ のみ（Phong/Lambert に PBR 値が無いため）。GLB/GLTF は作者値を保持。
  // 対応する PBR マップがあれば「意図した PBR」として上書きしない。
  if (resetPbrScalars) {
    if (!m.metalnessMap) m.metalness = NORMALIZE_METALNESS;
    if (!m.roughnessMap) m.roughness = NORMALIZE_ROUGHNESS;
  }
  m.needsUpdate = true;
}

/**
 * FBX/OBJ が生む MeshPhong/MeshLambert マテリアルを、GLB と同じ物理ベース MeshStandardMaterial へ置換する（260724・クライアント要望①）。
 * 背景: three r182 ではテクスチャの色空間(sRGB)は各ローダで統一済みだが、シーンの主光源が Environment(IBL)のため、
 * IBL の拡散光は PBR(MeshStandard) にしか届かず、Phong/Lambext(FBX/OBJ) は暗く見える。標準マテリアル化で GLB と明るさを揃える。
 * マップ/色/法線などは引き継ぐ。userData フラグで冪等（同一ルートの再変換はしない）。
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
      if (!p.isMeshPhongMaterial && !p.isMeshLambertMaterial) {
        normalizeStandardMaterial(m, true); // 既に Standard（テクスチャ埋め込みFBX等）は正規化のみ（FBX/OBJ なので PBR も統一）。
        return m;
      }
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
        roughness: NORMALIZE_ROUGHNESS, // FBX/OBJ に PBR 値は無いので中庸な既定（明るさは IBL で GLB と揃う）
        metalness: NORMALIZE_METALNESS,
      });
      if (p.normalScale) std.normalScale.copy(p.normalScale);
      std.name = p.name ?? '';
      m.dispose(); // 旧 Phong を破棄（このルート専用参照なので安全）
      normalizeStandardMaterial(std, true); // map→白・色空間＋FBX/OBJ の PBR 統一。
      return std;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convertOne) : convertOne(mesh.material);
  });
  return root;
}

/**
 * GLB/GLTF のマテリアルを正規化する（260725・クライアント要望①）。
 * useGLTF はシーンをキャッシュ共有するため、各マテリアルの冪等フラグ（normalizeStandardMaterial 内）で二重適用を防ぐ。
 * ジオメトリ/マップ/PBR スカラーは変更せず、テクスチャ有り材の color→白と色空間の統一のみを行う
 * （＝暗く/くすむテクスチャを正し、FBX とも明るさを揃える。金属/光沢など作者の PBR は保持）。
 */
function normalizeGltfMaterials(root: Object3D): Object3D {
  const ud = root.userData as { __matNormalizedGltf?: boolean };
  if (ud.__matNormalizedGltf) return root;
  ud.__matNormalizedGltf = true;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.material) return;
    // GLB/GLTF は PBR スカラーを保持（resetPbrScalars 既定 false）。
    // forEach の第2引数(index)が resetPbrScalars に渡らないよう、必ず1引数で呼ぶ。
    if (Array.isArray(mesh.material)) mesh.material.forEach((mm) => normalizeStandardMaterial(mm));
    else normalizeStandardMaterial(mesh.material);
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
  // GLB/GLTF のマテリアルを正規化する（テクスチャ有り材の map→白・色空間統一・260725 クライアント要望①）。
  // PBR スカラー（metalness/roughness）は作者値を保持（金属/光沢を潰さない）。冪等（マテリアル単位フラグ）なので
  // キャッシュ共有シーンでも安全。既存の draco/meshopt 設定・ジオメトリは不変。
  const normalized = useMemo(() => normalizeGltfMaterials(scene), [scene]);
  return children(normalized);
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
