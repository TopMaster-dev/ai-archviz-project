import { describe, it, expect } from 'vitest';
import {
  THUMBNAIL_CAMERA,
  THUMBNAIL_TARGET_RADIUS,
  maxSafeRadius,
  thumbnailFitScale,
} from './thumbnailFraming.js';

/**
 * 260730 クライアント要望④「サムネイルのモデルが小さい」。
 *
 * ここで守りたいのは1点だけ:「寄せても絶対に端が欠けないこと」。
 * 欠けたサムネイルはカタログ全体に出て、しかも再生成しないと直らない（保存されるため）。
 * 目分量で定数を上げると必ずどこかで欠けるので、幾何学的な上限をテストで固定する。
 */
describe('サムネイルの寄り', () => {
  it('切れない上限は sin で決まる（tan で見積もると必ず欠ける）', () => {
    // 透視投影では、原点中心・半径Rの球が収まる条件は R <= d*sin(fov/2)。
    // d*tan(fov/2) だと 3.84 になり、それを信じると端が欠ける。
    const d = THUMBNAIL_CAMERA.position[2];
    const half = (THUMBNAIL_CAMERA.fov * Math.PI) / 180 / 2;
    expect(maxSafeRadius()).toBeCloseTo(d * Math.sin(half), 6);
    expect(maxSafeRadius()).toBeCloseTo(3.0438, 3);
    expect(maxSafeRadius()).toBeLessThan(d * Math.tan(half)); // tan より必ず小さい
  });

  it('採用値は上限より小さい（＝どんな形でも欠けない）', () => {
    expect(THUMBNAIL_TARGET_RADIUS).toBeLessThan(maxSafeRadius());
    // 余裕が極端に少ないと、モデル側の誤差で欠ける。1割以上は残す。
    expect(THUMBNAIL_TARGET_RADIUS).toBeLessThan(maxSafeRadius() * 0.9);
  });

  it('従来（1.8）より確実に大きく写る', () => {
    expect(THUMBNAIL_TARGET_RADIUS).toBeGreaterThan(1.8);
  });

  it('外接球の半径を目標値へ合わせる倍率を返す', () => {
    expect(thumbnailFitScale(1)).toBeCloseTo(THUMBNAIL_TARGET_RADIUS);
    expect(thumbnailFitScale(5)).toBeCloseTo(THUMBNAIL_TARGET_RADIUS / 5);
    // 合わせた後の半径は、形に関係なく常に目標値。
    for (const r of [0.01, 0.5, 1, 12, 1000]) {
      expect(r * thumbnailFitScale(r)).toBeCloseTo(THUMBNAIL_TARGET_RADIUS, 6);
    }
  });

  it('壊れたモデル（半径0・NaN）でも落ちない', () => {
    // 頂点が1点しか無い/バウンディングが取れないモデルでも、生成キュー全体を止めてはいけない。
    expect(thumbnailFitScale(0)).toBe(1);
    expect(thumbnailFitScale(Number.NaN)).toBe(1);
    expect(thumbnailFitScale(-3)).toBe(1);
  });

  it('カメラは明示されている（ライブラリ既定に依存しない）', () => {
    // 既定任せだと、@react-three/fiber の既定カメラが変わった瞬間に
    // 全サムネイルの寄りが黙って変わる。値を固定しておく。
    expect(THUMBNAIL_CAMERA.fov).toBe(75);
    expect(THUMBNAIL_CAMERA.position).toEqual([0, 0, 5]);
  });
});
