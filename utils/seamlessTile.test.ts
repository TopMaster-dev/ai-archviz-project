import { describe, it, expect } from 'vitest';
import {
  luminanceAt,
  edgeMismatchScore,
  illuminationGradientScore,
  scoreTileability,
  makeSeamlessOffsetBlend,
  type RgbaImage
} from './seamlessTile.js';

// --- テスト画像の合成ヘルパ（canvas 不要・完全に決定論） ---

/** グレースケール画像（r=g=b=v なので Rec.709 輝度 = v）。 */
function grayImage(w: number, h: number, f: (x: number, y: number) => number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = f(x, y);
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const SIZE = 64;

/** 周期16のハッシュノイズ。16 は 64 を割り切るので画像全体としても厳密に周期的＝タイル可能。 */
const tileNoise = (x: number, y: number) => (((x % 16) * 37 + (y % 16) * 17) % 11) - 5;

/** 手続き生成のタイル可能テクスチャ（全成分が W/H の整数周期）。 */
const tileableImage = () =>
  grayImage(SIZE, SIZE, (x, y) => {
    const a = 30 * Math.sin((2 * Math.PI * x) / SIZE + 0.7) * Math.cos((2 * Math.PI * y) / SIZE + 0.3);
    const b = 18 * Math.sin((2 * Math.PI * 2 * x) / SIZE) * Math.sin((2 * Math.PI * 3 * y) / SIZE);
    return 128 + a + b + tileNoise(x, y);
  });

/** 照明は均一だが端が合わない画像（周期24の縦縞＝幅64を割り切らない＋微ノイズ）。 */
const offsetOkImage = () =>
  grayImage(SIZE, SIZE, (x, y) => (x % 24 < 12 ? 200 : 60) + (((x * 37 + y * 17) % 9) - 4));

/** 左→右の強い輝度ランプ（＝写真のライティング落ち・周辺減光相当）。 */
const rampImage = () =>
  grayImage(SIZE, SIZE, (x, y) => 30 + (190 * x) / (SIZE - 1) + (((x * 13 + y * 7) % 7) - 3));

describe('luminanceAt（Rec.709 輝度・260728）', () => {
  it('白/黒/原色の輝度を Rec.709 係数で返す', () => {
    const img: RgbaImage = {
      width: 5,
      height: 1,
      // 白, 黒, 赤, 緑, 青
      data: [255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]
    };
    expect(luminanceAt(img, 0, 0)).toBeCloseTo(255, 5);
    expect(luminanceAt(img, 1, 0)).toBeCloseTo(0, 5);
    expect(luminanceAt(img, 2, 0)).toBeCloseTo(0.2126 * 255, 5);
    expect(luminanceAt(img, 3, 0)).toBeCloseTo(0.7152 * 255, 5);
    expect(luminanceAt(img, 4, 0)).toBeCloseTo(0.0722 * 255, 5);
  });

  it('範囲外座標はクランプ、退化入力は 0（throw しない）', () => {
    const img = grayImage(4, 4, () => 100);
    expect(luminanceAt(img, -5, -5)).toBeCloseTo(100, 5);
    expect(luminanceAt(img, 99, 99)).toBeCloseTo(100, 5);
    expect(luminanceAt(img, 1.7, 2.9)).toBeCloseTo(100, 5); // 小数は floor
    expect(luminanceAt({ width: 0, height: 0, data: [] }, 0, 0)).toBe(0);
    // data が足りない壊れた入力でも 0
    expect(luminanceAt({ width: 4, height: 4, data: [0, 0] }, 3, 3)).toBe(0);
  });
});

describe('edgeMismatchScore（端の繋がらなさ・260728）', () => {
  it('ベタ塗り（平坦）は 0除算せず 1 を返す', () => {
    expect(edgeMismatchScore(grayImage(16, 16, () => 120))).toBe(1);
  });

  it('手続き生成のタイル可能画像は ~1.0（しきい値1.5未満）', () => {
    const s = edgeMismatchScore(tileableImage());
    expect(s).toBeLessThan(1.5);
    expect(s).toBeGreaterThan(0);
  });

  it('周期が幅を割り切らない縞は端が合わず 1.5 以上', () => {
    expect(edgeMismatchScore(offsetOkImage())).toBeGreaterThanOrEqual(1.5);
  });

  it('平坦地に端だけ段差がある場合も 0除算せず大きな比になる', () => {
    // 左端列だけ暗い＝内部の隣接差は 0（中央値0）だが端の差は大きい
    const img = grayImage(16, 16, (x) => (x === 0 ? 60 : 200));
    expect(edgeMismatchScore(img)).toBeGreaterThanOrEqual(1.5);
  });

  it('退化入力（空・1x1）でも throw せず 1', () => {
    expect(edgeMismatchScore({ width: 0, height: 0, data: [] })).toBe(1);
    expect(edgeMismatchScore({ width: 1, height: 1, data: [10, 20, 30, 255] })).toBe(1);
  });
});

describe('illuminationGradientScore（照明ムラ・260728）', () => {
  it('均一な明るさなら ~0', () => {
    expect(illuminationGradientScore(grayImage(32, 32, () => 140))).toBeCloseTo(0, 6);
    expect(illuminationGradientScore(tileableImage())).toBeLessThan(0.06);
    expect(illuminationGradientScore(offsetOkImage())).toBeLessThan(0.06);
  });

  it('左→右のランプは 0.06 以上（オフセット＋ブレンドでは直せない写真）', () => {
    expect(illuminationGradientScore(rampImage())).toBeGreaterThanOrEqual(0.06);
  });

  it('上→下のランプも検出する（軸の最大値を返す）', () => {
    const img = grayImage(SIZE, SIZE, (_x, y) => 40 + (170 * y) / (SIZE - 1));
    expect(illuminationGradientScore(img)).toBeGreaterThanOrEqual(0.06);
  });

  it('真っ黒（平均0）や空画像は 0（相対量が定義できないので暴発させない）', () => {
    expect(illuminationGradientScore(grayImage(8, 8, () => 0))).toBe(0);
    expect(illuminationGradientScore({ width: 0, height: 0, data: [] })).toBe(0);
  });
});

describe('scoreTileability（3択の推奨・260728）', () => {
  it('タイル可能な手続きテクスチャ → tileable', () => {
    const r = scoreTileability(tileableImage());
    expect(r.verdict).toBe('tileable');
    expect(r.edgeMismatch).toBeLessThan(1.5);
    expect(r.illuminationGradient).toBeLessThan(0.06);
  });

  it('照明ランプ → photo（照明ムラを最優先で弾く）', () => {
    const r = scoreTileability(rampImage());
    expect(r.illuminationGradient).toBeGreaterThanOrEqual(0.06);
    expect(r.verdict).toBe('photo');
  });

  it('照明は均一だが端が合わない → offset-ok', () => {
    const r = scoreTileability(offsetOkImage());
    expect(r.illuminationGradient).toBeLessThan(0.06);
    expect(r.edgeMismatch).toBeGreaterThanOrEqual(1.5);
    expect(r.verdict).toBe('offset-ok');
  });

  it('端が偶然合っていても照明ムラがあれば photo（tileable と誤答しない）', () => {
    // 端の輝度は一致させつつ全体は山なりの照明ムラ（中央が明るい）にする
    const img = grayImage(SIZE, SIZE, (x, y) => {
      const ramp = 30 + (190 * x) / (SIZE - 1);
      return ramp + (((x * 13 + y * 7) % 7) - 3);
    });
    const r = scoreTileability(img);
    expect(r.verdict).toBe('photo');
  });

  it('空画像でも throw しない（安全側の tileable）', () => {
    expect(() => scoreTileability({ width: 0, height: 0, data: [] })).not.toThrow();
    expect(scoreTileability({ width: 0, height: 0, data: [] }).verdict).toBe('tileable');
  });
});

describe('makeSeamlessOffsetBlend（半オフセット＋羽根ブレンド・260728）', () => {
  it('同じ寸法を返し、入力を一切変更しない', () => {
    const img = offsetOkImage();
    const before = Array.from(img.data);
    const out = makeSeamlessOffsetBlend(img);
    expect(out.width).toBe(img.width);
    expect(out.height).toBe(img.height);
    expect(out.data.length).toBe(img.data.length);
    expect(Array.from(img.data)).toEqual(before); // 非破壊
    expect(out.data).not.toBe(img.data);
  });

  it('offset-ok 画像の edgeMismatchScore を実測で下げる', () => {
    const img = offsetOkImage();
    const before = edgeMismatchScore(img);
    const after = edgeMismatchScore(makeSeamlessOffsetBlend(img));
    expect(before).toBeGreaterThanOrEqual(1.5);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(1.5); // 端が繋がった＝タイル可能側へ移る
  });

  it('featherRatio=0 は純粋な半オフセット（画素完全一致）', () => {
    const img = offsetOkImage();
    const out = makeSeamlessOffsetBlend(img, 0);
    const ox = SIZE / 2;
    const oy = SIZE / 2;
    for (const [x, y] of [
      [0, 0],
      [5, 61],
      [31, 32],
      [63, 63]
    ]) {
      const o = (y * SIZE + x) * 4;
      const s = (((y + oy) % SIZE) * SIZE + ((x + ox) % SIZE)) * 4;
      expect(out.data[o]).toBe(img.data[s]);
      expect(out.data[o + 3]).toBe(img.data[s + 3]);
    }
  });

  it('フェザーを効かせても端の列はロール結果そのまま（タイル性を壊さない）', () => {
    const img = offsetOkImage();
    const out = makeSeamlessOffsetBlend(img);
    const feather = Math.round(0.08 * SIZE); // 既定フェザー幅（=5px）
    for (let y = 0; y < SIZE; y += 1) {
      // 横シーム（y=H/2）の帯だけは端の列でも行方向にブレンドされる（横シームは全幅に走るので当然）。
      // その場合も左右端は同じ重みで処理されるため、元画像で隣り合う列どうしのままでタイル性は保たれる。
      if (Math.abs(y + 0.5 - SIZE / 2) < feather) continue;
      const left = (y * SIZE + 0) * 4;
      const right = (y * SIZE + (SIZE - 1)) * 4;
      const srcLeft = (((y + SIZE / 2) % SIZE) * SIZE + SIZE / 2) * 4;
      const srcRight = (((y + SIZE / 2) % SIZE) * SIZE + (SIZE / 2 - 1)) * 4;
      expect(out.data[left]).toBe(img.data[srcLeft]);
      expect(out.data[right]).toBe(img.data[srcRight]);
    }
  });

  it('中央の十字（旧シーム）の段差がブレンドで小さくなる', () => {
    const img = offsetOkImage();
    const out = makeSeamlessOffsetBlend(img);
    const rolled = makeSeamlessOffsetBlend(img, 0); // ブレンド無し＝十字に段差が残る
    const seamJump = (im: RgbaImage) => {
      let sum = 0;
      for (let y = 0; y < SIZE; y += 1) {
        sum += Math.abs(luminanceAt(im, SIZE / 2 - 1, y) - luminanceAt(im, SIZE / 2, y));
      }
      return sum / SIZE;
    };
    expect(seamJump(out)).toBeLessThan(seamJump(rolled));
  });

  it('退化入力（空・1x1・2x2・data不足）でも throw しない', () => {
    expect(() => makeSeamlessOffsetBlend({ width: 0, height: 0, data: [] })).not.toThrow();
    const empty = makeSeamlessOffsetBlend({ width: 0, height: 0, data: [] });
    expect(empty.width).toBe(0);
    expect(empty.data.length).toBe(0);

    const one = makeSeamlessOffsetBlend({ width: 1, height: 1, data: [10, 20, 30, 255] });
    expect(one.width).toBe(1);
    expect(one.height).toBe(1);
    expect(Array.from(one.data)).toEqual([10, 20, 30, 255]);

    expect(() => makeSeamlessOffsetBlend(grayImage(2, 2, () => 10))).not.toThrow();
    expect(() => makeSeamlessOffsetBlend({ width: 4, height: 4, data: [1, 2, 3] })).not.toThrow();
  });

  it('異常な featherRatio（NaN/負/巨大）でも寸法を保ち throw しない', () => {
    const img = offsetOkImage();
    for (const r of [Number.NaN, -1, 5, Number.POSITIVE_INFINITY]) {
      const out = makeSeamlessOffsetBlend(img, r);
      expect(out.width).toBe(SIZE);
      expect(out.height).toBe(SIZE);
      expect(out.data.length).toBe(SIZE * SIZE * 4);
    }
  });
});
