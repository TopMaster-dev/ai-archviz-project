import type { ReactElement } from 'react';
import { useLoader } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { Object3D } from 'three';
import { modelFormatOf, type ModelFormat } from '../utils/modelFormat.js';

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
  return children(root);
}

function ObjRoot({ url, children }: { url: string; children: SingleRenderer }) {
  const root = useLoader(OBJLoader, url);
  return children(root);
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
