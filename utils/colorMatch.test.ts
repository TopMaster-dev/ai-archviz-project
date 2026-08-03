import { describe, it, expect } from 'vitest';
import { computeChannelGains, applyGainsLinear } from './colorMatch.js';

/**
 * 260803 クライアント指摘「高解像度＋AI精細化で赤みが出る（再発）」。
 *
 * 色合わせ自体は動いていたが、白飛びした窓を含めて平均していたため、
 * 「色が無い白」が平均を支配して『もう合っている』と誤判定し、補正がほぼ効いていなかった。
 * 実際、白飛びの無い夜のオフィスでは赤みが出ず、窓の大きい昼のリビングだけで出ていた。
 *
 * ここでは同じ条件を数値で再現し、修正後に補正が効くことを固定する。
 */

/** w×h の RGBA を作る。fill(x,y) が [r,g,b] を返す。 */
function makeImage(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = fill(x, y);
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  return d;
}

const W = 40;
const H = 40;

describe('暖色ズレの補正', () => {
  it('全体が暖色へ寄った画像を、参照の色へ戻す方向のゲインを出す', () => {
    const ref = makeImage(W, H, () => [128, 128, 128]);
    // 赤を上げ青を下げた＝暖色に寄った状態
    const img = makeImage(W, H, () => [150, 128, 110]);
    const g = computeChannelGains(img, ref)!;
    expect(g).not.toBeNull();
    expect(g[0]).toBeLessThan(1); // 赤を下げる
    expect(g[2]).toBeGreaterThan(1); // 青を上げる
  });

  it('補正を適用すると参照へ近づく', () => {
    const ref = makeImage(W, H, () => [128, 128, 128]);
    const img = makeImage(W, H, () => [150, 128, 110]);
    const before = Math.abs(img[0] - ref[0]) + Math.abs(img[2] - ref[2]);
    const g = computeChannelGains(img, ref)!;
    const after = new Uint8ClampedArray(img);
    applyGainsLinear(after, g);
    const diff = Math.abs(after[0] - ref[0]) + Math.abs(after[2] - ref[2]);
    expect(diff).toBeLessThan(before);
  });

  it('色が合っている画像は補正しない（無駄な再エンコードを避ける）', () => {
    const ref = makeImage(W, H, () => [128, 128, 128]);
    const img = makeImage(W, H, () => [128, 128, 128]);
    expect(computeChannelGains(img, ref)).toBeNull();
  });
});

describe('白飛びした窓があっても補正が効く（今回の不具合そのもの）', () => {
  /**
   * 昼のリビング＝画面の6割が白飛びした窓、残り4割が室内。
   * 室内だけが暖色に寄っている状態を作る。
   * 旧実装は白い窓を含めて平均したため、ゲインがほぼ1になって補正が効かなかった。
   */
  const isWindow = (x: number) => x < W * 0.6;
  const refDaylight = makeImage(W, H, (x) => (isWindow(x) ? [255, 255, 255] : [120, 118, 116]));
  const imgDaylight = makeImage(W, H, (x) => (isWindow(x) ? [255, 255, 255] : [150, 118, 96]));

  it('室内部分の暖色ズレを検出できる', () => {
    const g = computeChannelGains(imgDaylight, refDaylight)!;
    expect(g).not.toBeNull();
    expect(g[0]).toBeLessThan(0.95); // 赤をはっきり下げる
    expect(g[2]).toBeGreaterThan(1.05); // 青をはっきり上げる
  });

  it('白飛びを含めて平均した場合より、補正が強く出る', () => {
    // 旧実装相当（全画素の単純平均比）を再現して比較する。
    const meanOf = (d: Uint8ClampedArray, c: number) => {
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i + c];
      return s / (d.length / 4);
    };
    const naiveRedGain = meanOf(refDaylight, 0) / meanOf(imgDaylight, 0);
    const g = computeChannelGains(imgDaylight, refDaylight)!;
    // 1 からの距離＝補正の強さ。新実装のほうが強く補正する。
    expect(Math.abs(g[0] - 1)).toBeGreaterThan(Math.abs(naiveRedGain - 1));
  });

  it('夜のオフィス（白飛びなし）でも従来どおり効く', () => {
    const ref = makeImage(W, H, () => [40, 44, 60]);
    const img = makeImage(W, H, () => [52, 44, 52]);
    const g = computeChannelGains(img, ref)!;
    expect(g[0]).toBeLessThan(1);
    expect(g[2]).toBeGreaterThan(1);
  });
});

describe('安全側の動作', () => {
  it('判断材料が足りなければ補正しない（ほぼ全面が白飛び）', () => {
    const ref = makeImage(W, H, () => [255, 255, 255]);
    const img = makeImage(W, H, () => [255, 250, 250]);
    expect(computeChannelGains(img, ref)).toBeNull();
  });

  it('ゲインは上下限を超えない（統計が壊れても大きく外さない）', () => {
    const ref = makeImage(W, H, () => [200, 100, 20]);
    const img = makeImage(W, H, () => [20, 100, 200]);
    const g = computeChannelGains(img, ref)!;
    for (const v of g) {
      expect(v).toBeGreaterThanOrEqual(0.8);
      expect(v).toBeLessThanOrEqual(1.25);
    }
  });

  it('明るい部分でも補正が捨てられない（上限での切り捨てをしない）', () => {
    // 青を持ち上げる補正を、青が既に高い画素へ適用する。
    // 単純な切り捨てだと変化量が0になるが、ソフトに丸めるので必ず増える。
    const d = makeImage(2, 2, () => [200, 200, 245]);
    const before = d[2];
    applyGainsLinear(d, [1, 1, 1.2]);
    expect(d[2]).toBeGreaterThan(before);
    expect(d[2]).toBeLessThanOrEqual(255);
  });

  it('アルファは変更しない', () => {
    const d = makeImage(4, 4, () => [100, 100, 100]);
    for (let i = 3; i < d.length; i += 4) d[i] = 128;
    applyGainsLinear(d, [0.9, 1.0, 1.1]);
    for (let i = 3; i < d.length; i += 4) expect(d[i]).toBe(128);
  });

  it('画素値は 0〜255 に収まる', () => {
    const d = makeImage(8, 8, (x) => [x * 30, 255 - x * 30, 128]);
    applyGainsLinear(d, [1.25, 0.8, 1.25]);
    for (const v of d) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});
