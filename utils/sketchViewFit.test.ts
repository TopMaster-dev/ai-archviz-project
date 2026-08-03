import { describe, it, expect } from 'vitest';
import {
  boundsFromPoints,
  boundsFromRect,
  boundsFromRotatedRect,
  unionBounds,
  unionAllBounds,
  computeFitView,
  computeMinZoom,
  type BoundsMm,
} from './sketchViewFit.js';

/**
 * 2Dビューの全体表示（260806 クライアント要望④）。
 *
 * 3D→2D の切り替えで図面が画面外に出て真っ暗になる、という不具合の対策。
 * ここが狂うと「図面が見えない」か「見当違いの場所へ飛ぶ」ため、
 * 中央に来ること・必ず収まることを数値で押さえる。
 */

const FIT = { paddingMm: 1000, maxZoom: 2.0, minZoom: 0.0025 };

describe('外接矩形', () => {
  it('点群を囲む', () => {
    expect(boundsFromPoints([{ x: 0, y: 0 }, { x: 3000, y: 2000 }, { x: -500, y: 900 }])).toEqual({
      minX: -500, minY: 0, maxX: 3000, maxY: 2000,
    });
  });

  it('点が無ければ null（「中身なし」を呼び出し側が判別できる）', () => {
    expect(boundsFromPoints([])).toBeNull();
    expect(boundsFromPoints(null)).toBeNull();
    expect(boundsFromPoints(undefined)).toBeNull();
  });

  it('壊れた点は無視する（1つの NaN で全体が NaN になり視点が飛ぶのを防ぐ）', () => {
    const b = boundsFromPoints([{ x: 0, y: 0 }, { x: NaN, y: 5 }, { x: 1000, y: 1000 }]);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  });

  it('全部壊れていれば null', () => {
    expect(boundsFromPoints([{ x: NaN, y: NaN }, { x: Infinity, y: 0 }])).toBeNull();
  });

  it('矩形は順序が逆でも受ける', () => {
    expect(boundsFromRect(3000, 2000, 0, 0)).toEqual({ minX: 0, minY: 0, maxX: 3000, maxY: 2000 });
    expect(boundsFromRect(0, 0, NaN, 100)).toBeNull();
  });
});

describe('回転した矩形（梁）の外接矩形', () => {
  it('0°なら長さ×幅そのまま', () => {
    expect(boundsFromRotatedRect(0, 0, 4000, 200, 0)).toEqual({ minX: -2000, minY: -100, maxX: 2000, maxY: 100 });
  });

  it('90°なら縦横が入れ替わる', () => {
    const b = boundsFromRotatedRect(0, 0, 4000, 200, 90)!;
    expect(b.maxX).toBeCloseTo(100, 6);
    expect(b.maxY).toBeCloseTo(2000, 6);
  });

  it('45°は対角ぶん広がる', () => {
    const b = boundsFromRotatedRect(0, 0, 4000, 200, 45)!;
    const expected = (Math.SQRT1_2 * 4000) / 2 + (Math.SQRT1_2 * 200) / 2;
    expect(b.maxX).toBeCloseTo(expected, 6);
    expect(b.maxY).toBeCloseTo(expected, 6);
  });

  it('どの角度でも図形を必ず含む（収まらない事故を起こさない）', () => {
    // 実際の四隅を回して、外接矩形がそれを包含していることを確かめる。
    for (let deg = 0; deg < 360; deg += 7) {
      const L = 4000, W = 600, cx = 1234, cy = -987;
      const b = boundsFromRotatedRect(cx, cy, L, W, deg)!;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      for (const [lx, ly] of [[L / 2, W / 2], [-L / 2, W / 2], [L / 2, -W / 2], [-L / 2, -W / 2]]) {
        const x = cx + lx * cos - ly * sin;
        const y = cy + lx * sin + ly * cos;
        expect(x, `deg=${deg}`).toBeGreaterThanOrEqual(b.minX - 1e-6);
        expect(x, `deg=${deg}`).toBeLessThanOrEqual(b.maxX + 1e-6);
        expect(y, `deg=${deg}`).toBeGreaterThanOrEqual(b.minY - 1e-6);
        expect(y, `deg=${deg}`).toBeLessThanOrEqual(b.maxY + 1e-6);
      }
    }
  });

  it('壊れた入力は null', () => {
    expect(boundsFromRotatedRect(NaN, 0, 100, 100, 0)).toBeNull();
    expect(boundsFromRotatedRect(0, 0, 100, 100, NaN)).toBeNull();
  });
});

describe('外接矩形の合成', () => {
  const a: BoundsMm = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const b: BoundsMm = { minX: -50, minY: 200, maxX: 50, maxY: 300 };

  it('両方を含む', () => {
    expect(unionBounds(a, b)).toEqual({ minX: -50, minY: 0, maxX: 100, maxY: 300 });
  });

  it('片方が null ならもう片方（中身が部分的に無くても壊れない）', () => {
    expect(unionBounds(a, null)).toEqual(a);
    expect(unionBounds(null, b)).toEqual(b);
    expect(unionBounds(null, null)).toBeNull();
  });

  it('まとめて合成できる', () => {
    expect(unionAllBounds([null, a, null, b])).toEqual({ minX: -50, minY: 0, maxX: 100, maxY: 300 });
    expect(unionAllBounds([])).toBeNull();
    expect(unionAllBounds([null, null])).toBeNull();
  });
});

describe('全体表示のズームとオフセット', () => {
  it('図面の中心が画面の中心に来る', () => {
    // 原点から遠い図面（今回の不具合の再現条件）。
    const bounds: BoundsMm = { minX: 50000, minY: 40000, maxX: 60000, maxY: 46000 };
    const view = computeFitView(bounds, 1000, 800, FIT)!;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    // 画面座標 = mm × zoom + offset
    expect(cx * view.zoom + view.offset.x).toBeCloseTo(500, 6);
    expect(cy * view.zoom + view.offset.y).toBeCloseTo(400, 6);
  });

  it('図面の四隅が画面の中に収まる（はみ出さない）', () => {
    const bounds: BoundsMm = { minX: 50000, minY: 40000, maxX: 60000, maxY: 46000 };
    const view = computeFitView(bounds, 1000, 800, FIT)!;
    const x0 = bounds.minX * view.zoom + view.offset.x;
    const x1 = bounds.maxX * view.zoom + view.offset.x;
    const y0 = bounds.minY * view.zoom + view.offset.y;
    const y1 = bounds.maxY * view.zoom + view.offset.y;
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThanOrEqual(1000);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(y1).toBeLessThanOrEqual(800);
  });

  it('余白のぶんだけ内側に入る', () => {
    // 幅ぴったりで決まる形にして、左端が padding×zoom ぶん内側に来ることを見る。
    const bounds: BoundsMm = { minX: 0, minY: 0, maxX: 10000, maxY: 100 };
    const view = computeFitView(bounds, 1000, 800, FIT)!;
    expect(bounds.minX * view.zoom + view.offset.x).toBeCloseTo(FIT.paddingMm * view.zoom, 6);
  });

  it('小さい図面でも上限より拡大しない（過剰に寄らない）', () => {
    // 余白1000mmが効くので、小さい図面でも余白ぶんまでしか寄らない。
    const withPad = computeFitView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 1000, 800, FIT)!;
    expect(withPad.zoom).toBeLessThanOrEqual(FIT.maxZoom);
    expect(withPad.zoom).toBeCloseTo(800 / (10 + 1000 * 2), 6);

    // 余白を外すと上限で頭打ちになる（青天井に拡大しない）。
    const noPad = computeFitView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 1000, 800, { ...FIT, paddingMm: 0 })!;
    expect(noPad.zoom).toBe(FIT.maxZoom);
  });

  it('巨大な図面でも下限を下回らない（0に潰れない）', () => {
    const huge = 1e12;
    const view = computeFitView({ minX: 0, minY: 0, maxX: huge, maxY: huge }, 1000, 800, FIT)!;
    expect(view.zoom).toBe(FIT.minZoom);
    expect(Number.isFinite(view.offset.x)).toBe(true);
  });

  it('点1つ・線1本でも 0 除算にならない（余白があるため）', () => {
    const dot = computeFitView({ minX: 5000, minY: 5000, maxX: 5000, maxY: 5000 }, 1000, 800, FIT)!;
    expect(dot.zoom).toBeGreaterThan(0);
    expect(5000 * dot.zoom + dot.offset.x).toBeCloseTo(500, 6);

    const line = computeFitView({ minX: 0, minY: 500, maxX: 8000, maxY: 500 }, 1000, 800, FIT)!;
    expect(line.zoom).toBeGreaterThan(0);
  });

  it('中身が無い・キャンバス未実測なら null（視点を勝手に動かさない）', () => {
    expect(computeFitView(null, 1000, 800, FIT)).toBeNull();
    expect(computeFitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 0, 800, FIT)).toBeNull();
    expect(computeFitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 1000, 0, FIT)).toBeNull();
    expect(computeFitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, NaN, 800, FIT)).toBeNull();
  });

  it('壊れた外接矩形は null', () => {
    expect(computeFitView({ minX: NaN, minY: 0, maxX: 100, maxY: 100 }, 1000, 800, FIT)).toBeNull();
    expect(computeFitView({ minX: 0, minY: 0, maxX: Infinity, maxY: 100 }, 1000, 800, FIT)).toBeNull();
  });

  it('縦長の画面でも高さで決まり、はみ出さない', () => {
    const bounds: BoundsMm = { minX: 0, minY: 0, maxX: 4000, maxY: 30000 };
    const view = computeFitView(bounds, 1000, 400, FIT)!;
    const y0 = bounds.minY * view.zoom + view.offset.y;
    const y1 = bounds.maxY * view.zoom + view.offset.y;
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(y1).toBeLessThanOrEqual(400);
  });
});

/**
 * 全体表示とズームアウト下限の整合（敵対レビューで見つかった不具合）。
 *
 * 下限を「作図点だけ」から求めていたため、中身が作図点より大きいとき
 * （大きな下絵・部屋の外へ出した家具や自由梁）に
 * 「全体表示のズーム ＜ 縮小の下限」になり、全体表示の直後に「−」を押すと逆に拡大した。
 */
describe('ズームアウト下限は全体表示と食い違わない', () => {
  const REL = 0.2;

  it('下限は必ず全体表示のズーム以下（全体表示の直後に縮小できる）', () => {
    const cases: BoundsMm[] = [
      { minX: 0, minY: 0, maxX: 5000, maxY: 4000 },          // 小さな部屋
      { minX: 0, minY: 0, maxX: 84000, maxY: 59000 },        // A1を1/100で取り込んだ下絵
      { minX: -60000, minY: -40000, maxX: 60000, maxY: 40000 },
      { minX: 10, minY: 10, maxX: 12, maxY: 12 },            // ほぼ点
    ];
    for (const b of cases) {
      const fit = computeFitView(b, 1400, 800, FIT)!;
      const min = computeMinZoom(b, 1400, 800, FIT, REL);
      expect(min, JSON.stringify(b)).toBeLessThanOrEqual(fit.zoom);
    }
  });

  it('通常は全体表示の 0.2 倍まで引ける', () => {
    const b: BoundsMm = { minX: 0, minY: 0, maxX: 5000, maxY: 4000 };
    const fit = computeFitView(b, 1400, 800, FIT)!;
    expect(computeMinZoom(b, 1400, 800, FIT, REL)).toBeCloseTo(fit.zoom * REL, 10);
  });

  it('巨大な下絵でも下限がグローバル下限を下回らない', () => {
    const b: BoundsMm = { minX: 0, minY: 0, maxX: 1e9, maxY: 1e9 };
    expect(computeMinZoom(b, 1400, 800, FIT, REL)).toBeGreaterThanOrEqual(FIT.minZoom);
  });

  it('中身が無ければグローバル下限', () => {
    expect(computeMinZoom(null, 1400, 800, FIT, REL)).toBe(FIT.minZoom);
  });
});
