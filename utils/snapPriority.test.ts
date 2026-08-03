import { describe, it, expect } from 'vitest';
import { hasExplicitSnap, shouldUseAlignSnap, type SnapSettings } from './snapPriority.js';

/**
 * 260803 クライアント指摘「頂点の延長線上へ勝手に吸着し、長さ・角度・グリッドの設定が効かない」。
 *
 * 整列スナップ（既存頂点と同じX/Yへ揃える）が、利用者の明示設定より先に成立して確定していた。
 * ご要望は「長さ・角度・グリッドが常に優先」。3つとも無効のときだけ整列が効く形にする。
 * 優先順位は目視で確かめにくく、崩れても「たまたま今の操作では気付かない」ため数値で固定する。
 */

const base: SnapSettings = {
  lengthEnabled: false,
  lengthMm: 100,
  angleEnabled: false,
  angleDeg: 15,
  gridEnabled: false,
  gridMm: 1000,
};

describe('明示的なスナップが有効なとき、整列スナップは効かない', () => {
  it('長さスナップON', () => {
    expect(shouldUseAlignSnap({ ...base, lengthEnabled: true })).toBe(false);
  });

  it('角度スナップON', () => {
    expect(shouldUseAlignSnap({ ...base, angleEnabled: true })).toBe(false);
  });

  it('グリッドスナップON', () => {
    expect(shouldUseAlignSnap({ ...base, gridEnabled: true })).toBe(false);
  });

  it('既定の状態（長さ100mm・角度15°がON）でも効かない', () => {
    // 画面の初期状態がこれ。クライアントが実際に困っていた条件そのもの。
    expect(shouldUseAlignSnap({ ...base, lengthEnabled: true, angleEnabled: true })).toBe(false);
  });
});

describe('3つとも無効のときだけ整列スナップが効く', () => {
  it('すべてOFFなら効く', () => {
    expect(shouldUseAlignSnap(base)).toBe(true);
  });

  it('有効でも刻みが0以下なら実質無効として扱う', () => {
    // 0や負の刻みは割り算が成立せずスナップできない。フラグだけ見て「有効」と判断しない。
    expect(shouldUseAlignSnap({ ...base, lengthEnabled: true, lengthMm: 0 })).toBe(true);
    expect(shouldUseAlignSnap({ ...base, angleEnabled: true, angleDeg: 0 })).toBe(true);
    expect(shouldUseAlignSnap({ ...base, gridEnabled: true, gridMm: -1 })).toBe(true);
  });
});

describe('hasExplicitSnap', () => {
  it('1つでも有効なら true', () => {
    expect(hasExplicitSnap({ ...base, gridEnabled: true })).toBe(true);
  });

  it('shouldUseAlignSnap は常にその否定', () => {
    for (const s of [
      base,
      { ...base, lengthEnabled: true },
      { ...base, angleEnabled: true },
      { ...base, gridEnabled: true },
      { ...base, lengthEnabled: true, angleEnabled: true, gridEnabled: true },
    ]) {
      expect(shouldUseAlignSnap(s)).toBe(!hasExplicitSnap(s));
    }
  });
});
