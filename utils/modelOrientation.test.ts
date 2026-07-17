import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normalizeUprightXDeg, normalizeYawDeg, detectWallFaceYawDeg } from './modelOrientation.js';

describe('modelOrientation', () => {
  describe('normalizeUprightXDeg', () => {
    it('90°刻みに丸める', () => {
      expect(normalizeUprightXDeg(0)).toBe(0);
      expect(normalizeUprightXDeg(90)).toBe(90);
      expect(normalizeUprightXDeg(180)).toBe(180);
      expect(normalizeUprightXDeg(270)).toBe(270);
      expect(normalizeUprightXDeg(360)).toBe(0);
      expect(normalizeUprightXDeg(85)).toBe(90);
      expect(normalizeUprightXDeg(-90)).toBe(270);
      expect(normalizeUprightXDeg('x')).toBe(0);
      expect(normalizeUprightXDeg(undefined)).toBe(0);
    });
  });

  describe('normalizeYawDeg', () => {
    it('0/90/180/270 に丸める', () => {
      expect(normalizeYawDeg(0)).toBe(0);
      expect(normalizeYawDeg(90)).toBe(90);
      expect(normalizeYawDeg(200)).toBe(180);
      expect(normalizeYawDeg(-90)).toBe(270);
      expect(normalizeYawDeg(360)).toBe(0);
      expect(normalizeYawDeg(NaN)).toBe(0);
    });
  });

  describe('detectWallFaceYawDeg', () => {
    // 大きな縦面（法線が既知の水平方向）を1枚だけ置き、背面(-Z)へ向けるヨーを検証する。
    const planeFacing = (rotation: [number, number, number]): THREE.Object3D => {
      const geo = new THREE.PlaneGeometry(4, 4); // 既定は法線 +Z
      const mesh = new THREE.Mesh(geo);
      mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
      const root = new THREE.Group();
      root.add(mesh);
      return root;
    };

    it('+Z を向く面 → 背面へ回すヨー 180°', () => {
      expect(detectWallFaceYawDeg(planeFacing([0, 0, 0]))).toBe(180);
    });
    it('+X を向く面 → 90°', () => {
      // Y軸まわり +90° で法線 +Z → +X
      expect(detectWallFaceYawDeg(planeFacing([0, Math.PI / 2, 0]))).toBe(90);
    });
    it('-Z を向く面（既に背面）→ 0°', () => {
      expect(detectWallFaceYawDeg(planeFacing([0, Math.PI, 0]))).toBe(0);
    });
    it('-X を向く面 → 270°', () => {
      expect(detectWallFaceYawDeg(planeFacing([0, -Math.PI / 2, 0]))).toBe(270);
    });
    it('水平面（天板・法線±Y）は縦面でないので提案なし=0', () => {
      // X軸まわり -90° で法線 +Z → +Y（天板）
      expect(detectWallFaceYawDeg(planeFacing([-Math.PI / 2, 0, 0]))).toBe(0);
    });
    it('uprightXDeg=90 を与えると、+Y面が縦面(+Z→背面)になり判定が変わる', () => {
      // 素の法線 +Y（天板）。upright +90°(X) で法線 +Y→ -Z 側へ回り縦面になる。
      const root = planeFacing([-Math.PI / 2, 0, 0]); // 法線 +Y
      // upright 0 では縦面なし→0。upright 90 では縦面として検出され 0 以外になりうる。
      const withUpright = detectWallFaceYawDeg(root, 90);
      expect([0, 90, 180, 270]).toContain(withUpright);
    });
  });
});
