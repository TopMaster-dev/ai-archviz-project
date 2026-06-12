import { describe, it, expect } from 'vitest';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as THREE from 'three';

// three 0.182 の example ローダ（FBX/OBJ）が本プロジェクトの解決環境で実体化・実行できることを担保する。
// OBJ は .parse が同期・純粋なのでキューブ文字列を実際にパースして形状が得られることまで確認する。
const CUBE_OBJ = `# unit cube
v -0.5 -0.5 -0.5
v -0.5 -0.5 0.5
v -0.5 0.5 -0.5
v -0.5 0.5 0.5
v 0.5 -0.5 -0.5
v 0.5 -0.5 0.5
v 0.5 0.5 -0.5
v 0.5 0.5 0.5
f 1 2 4 3
f 5 7 8 6
f 1 5 6 2
f 3 4 8 7
f 1 3 7 5
f 2 6 8 4
`;

describe('3D model loaders (three example loaders)', () => {
  it('OBJLoader parses a cube into a renderable Object3D with geometry', () => {
    const root = new OBJLoader().parse(CUBE_OBJ);
    expect(root).toBeInstanceOf(THREE.Object3D);

    const meshes: THREE.Mesh[] = [];
    root.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh);
    });
    expect(meshes.length).toBeGreaterThan(0);

    const geom = meshes[0].geometry as THREE.BufferGeometry;
    expect(geom.getAttribute('position')).toBeTruthy();

    // バウンディングボックスが有限サイズ（ClayModel の clone/center/box 計測が機能する前提）。
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeGreaterThan(0);
    expect(size.y).toBeGreaterThan(0);
    expect(size.z).toBeGreaterThan(0);
  });

  it('FBXLoader is importable and constructable', () => {
    expect(() => new FBXLoader()).not.toThrow();
    expect(typeof new FBXLoader().load).toBe('function');
    expect(typeof new FBXLoader().parse).toBe('function');
  });
});
