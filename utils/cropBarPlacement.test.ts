import { describe, it, expect } from 'vitest';
import { placeCropBar, cropBarWidth } from './cropBarPlacement.js';

/**
 * 260731 クライアント要望③「注意事項とボタンをクロップ枠のすぐ下へ追従させる。
 * 枠を下部へ動かしたときは、画面外へ消えたり枠と被ったりしないよう自動的に枠の上へ」。
 *
 * 反転の境目は目視では確かめにくく、「今の画面サイズでは、たまたま起きない」形で
 * 壊れたまま残りやすい。数値で固定する。
 */

const wrap = { width: 800, height: 500 };
/** 注意文2行＋ボタン1行を想定した実測値相当。 */
const BAR_H = 64;

describe('枠の下に置く', () => {
  it('中央の枠なら真下に出る', () => {
    const p = placeCropBar({ frame: { left: 200, top: 125, width: 400, height: 250 }, wrap, barHeight: BAR_H });
    expect(p.placement).toBe('below');
    expect(p.top).toBe(125 + 250 + 8); // 枠の下端 + 間隔
  });

  it('枠が上にあるほどバーも上がる（追従する）', () => {
    const high = placeCropBar({ frame: { left: 200, top: 20, width: 400, height: 100 }, wrap, barHeight: BAR_H });
    const low = placeCropBar({ frame: { left: 200, top: 200, width: 400, height: 100 }, wrap, barHeight: BAR_H });
    expect(high.top).toBeLessThan(low.top);
    expect(high.placement).toBe('below');
    expect(low.placement).toBe('below');
  });
});

describe('枠が下部にあるときは上へ反転する', () => {
  it('下に入らなければ枠の上へ回る', () => {
    const p = placeCropBar({ frame: { left: 200, top: 300, width: 400, height: 190 }, wrap, barHeight: BAR_H });
    expect(p.placement).toBe('above');
    expect(p.top).toBe(300 - 8 - BAR_H); // 枠の上端 - 間隔 - バー高さ
  });

  it('反転してもプレビューの外へ出ない', () => {
    for (let top = 0; top <= 460; top += 10) {
      const p = placeCropBar({ frame: { left: 100, top, width: 300, height: 40 }, wrap, barHeight: BAR_H });
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.top + BAR_H).toBeLessThanOrEqual(wrap.height - 8);
    }
  });

  it('反転してもバーと枠は重ならない', () => {
    for (let top = 0; top <= 440; top += 10) {
      const frame = { left: 100, top, width: 300, height: 60 };
      const p = placeCropBar({ frame, wrap, barHeight: BAR_H });
      if (p.placement === 'inside') continue; // 枠が大きすぎる場合だけは重なりを許す
      const barBottom = p.top + BAR_H;
      const frameBottom = frame.top + frame.height;
      const overlaps = p.top < frameBottom && barBottom > frame.top;
      expect(overlaps).toBe(false);
    }
  });
});

describe('どちらにも入らないとき', () => {
  it('枠がほぼ全面でも画面内に留める（消えるより重なる方がまし）', () => {
    const p = placeCropBar({ frame: { left: 4, top: 4, width: 792, height: 492 }, wrap, barHeight: BAR_H });
    expect(p.placement).toBe('inside');
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + BAR_H).toBeLessThanOrEqual(wrap.height - 8);
  });

  it('プレビューがバーより低くても負の座標を返さない', () => {
    const p = placeCropBar({ frame: { left: 0, top: 0, width: 100, height: 30 }, wrap: { width: 300, height: 40 }, barHeight: BAR_H });
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.left).toBeGreaterThanOrEqual(0);
  });
});

describe('横位置', () => {
  it('枠の中心に合わせる', () => {
    const p = placeCropBar({ frame: { left: 150, top: 50, width: 500, height: 100 }, wrap, barHeight: BAR_H });
    expect(p.left + p.width / 2).toBeCloseTo(150 + 500 / 2, 5);
  });

  it('左右にはみ出さない（枠が端にあっても）', () => {
    for (const left of [0, 20, 400, 700, 780]) {
      const p = placeCropBar({ frame: { left, top: 50, width: 60, height: 60 }, wrap, barHeight: BAR_H });
      expect(p.left).toBeGreaterThanOrEqual(8);
      expect(p.left + p.width).toBeLessThanOrEqual(wrap.width - 8);
    }
  });
});

describe('横幅', () => {
  it('枠が狭くても文字が読める幅を確保する', () => {
    expect(cropBarWidth(80, 800)).toBe(520);
  });

  it('枠が広ければ枠に合わせる', () => {
    expect(cropBarWidth(700, 800)).toBe(700);
  });

  it('プレビューより広くならない（狭いパネルでも収まる）', () => {
    expect(cropBarWidth(700, 400)).toBe(400 - 16);
    expect(cropBarWidth(80, 300)).toBe(300 - 16);
  });

  it('極端に狭くても負の幅にしない', () => {
    expect(cropBarWidth(100, 10)).toBeGreaterThanOrEqual(0);
  });
});

/**
 * 260731 敵対レビューで見つかった穴。
 *
 * 拡大（最大6倍）とパンで、クロップ枠はプレビューの外まで動く。
 * 「下に入るか」だけ、「上に入るか」だけを見ていると、その外側の座標をそのまま返してしまい、
 * バーは overflow-hidden で丸ごと切り取られる＝「やめる」も「この範囲で検索」も押せない。
 * 枠がどこにあっても、バーは必ずプレビューの中に居ること。
 */
describe('枠がプレビューの外にあるとき', () => {
  const BAR = 64;

  it('枠が上へ大きく外れてもバーは画面内に残る', () => {
    const p = placeCropBar({ frame: { left: 100, top: -1375, width: 300, height: 1250 }, wrap, barHeight: BAR });
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + BAR).toBeLessThanOrEqual(wrap.height - 8);
  });

  it('枠が下へ大きく外れてもバーは画面内に残る', () => {
    const p = placeCropBar({ frame: { left: 100, top: 750, width: 300, height: 1500 }, wrap, barHeight: BAR });
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + BAR).toBeLessThanOrEqual(wrap.height - 8);
  });

  it('拡大・パンのどの組み合わせでも画面外へ出さない', () => {
    // 既定枠 {y:.25,h:.5} を dh=500 の画像に当て、zoom 1..6 / pan を可動域いっぱいに振る
    for (let zoom = 1; zoom <= 6; zoom += 0.5) {
      const minPanY = wrap.height * (1 - zoom);
      for (let panY = minPanY; panY <= 0; panY += Math.max(1, Math.abs(minPanY) / 8)) {
        const p = placeCropBar({
          frame: { left: 100, top: panY + zoom * 125, width: 300, height: zoom * 250 },
          wrap,
          barHeight: BAR,
        });
        expect(p.top, `zoom=${zoom} panY=${panY}`).toBeGreaterThanOrEqual(8);
        expect(p.top + BAR, `zoom=${zoom} panY=${panY}`).toBeLessThanOrEqual(wrap.height - 8);
      }
    }
  });

  it('小さく絞った枠を少し拡大しただけでも消えない（2倍で上へ外れる形）', () => {
    const p = placeCropBar({ frame: { left: 100, top: -342, width: 200, height: 100 }, wrap, barHeight: BAR });
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.placement).toBe('inside');
  });
});
