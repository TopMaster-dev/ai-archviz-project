import { describe, it, expect } from 'vitest';
import { unionAreaOfRects, mergeIntervals, type Rect } from './rectUnion.js';

const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });

describe('mergeIntervals', () => {
  it('空配列は空', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it('1本はそのまま', () => {
    expect(mergeIntervals([[1, 3]])).toEqual([[1, 3]]);
  });

  it('重なる区間は1本に結合', () => {
    expect(
      mergeIntervals([
        [0, 2],
        [1, 3]
      ])
    ).toEqual([[0, 3]]);
  });

  it('接している区間も結合する（面積として連続だから）', () => {
    expect(
      mergeIntervals([
        [0, 1],
        [1, 2]
      ])
    ).toEqual([[0, 2]]);
  });

  it('離れた区間は別々・開始位置昇順に並ぶ（入力順は問わない）', () => {
    expect(
      mergeIntervals([
        [5, 6],
        [0, 1]
      ])
    ).toEqual([
      [0, 1],
      [5, 6]
    ]);
  });

  it('内包された区間で上端が縮まない', () => {
    expect(
      mergeIntervals([
        [0, 10],
        [2, 3],
        [4, 5]
      ])
    ).toEqual([[0, 10]]);
  });

  it('反転区間は入れ替えて扱う', () => {
    expect(mergeIntervals([[3, 1]])).toEqual([[1, 3]]);
  });

  it('長さ0・非有限は無視', () => {
    expect(
      mergeIntervals([
        [2, 2],
        [Number.NaN, 1],
        [0, Number.POSITIVE_INFINITY],
        [1, 4]
      ])
    ).toEqual([[1, 4]]);
  });
});

describe('unionAreaOfRects', () => {
  it('矩形1つ 2×3 → 6', () => {
    expect(unionAreaOfRects([rect(0, 0, 2, 3)])).toBeCloseTo(6, 9);
  });

  it('完全に重なる 2×2 が2つ → 4（8でも0でもない）', () => {
    // 従来の「ペア交差を引く」方式なら 4+4-4=4 で偶然合うが、和集合なら定義から 4。
    expect(unionAreaOfRects([rect(0, 0, 2, 2), rect(0, 0, 2, 2)])).toBeCloseTo(4, 9);
  });

  it('離れた 2×2 が2つ → 8', () => {
    expect(unionAreaOfRects([rect(0, 0, 2, 2), rect(5, 5, 7, 7)])).toBeCloseTo(8, 9);
  });

  it('角が 1×1 だけ重なる 2×2 が2つ → 7', () => {
    expect(unionAreaOfRects([rect(0, 0, 2, 2), rect(1, 1, 3, 3)])).toBeCloseTo(7, 9);
  });

  it('同じ 2×2 を3枚が覆う → 4（包除原理の打ち切りが誤る典型例）', () => {
    // 打ち切り包除（Σ面積 − Σペア交差）だと 12 − 12 = 0 になってしまうケース。
    const area = unionAreaOfRects([rect(0, 0, 2, 2), rect(0, 0, 2, 2), rect(0, 0, 2, 2)]);
    expect(area).toBeCloseTo(4, 9);
    expect(area).not.toBeCloseTo(0, 9);
  });

  it('L字に3枚（角を共有）→ 手計算 4.25', () => {
    // A: 横アーム [0,2]×[0,1] = 2
    // B: 縦アーム [0,1]×[0,3] = 3   （A∩B = [0,1]×[0,1] = 1 → A∪B = 4）
    // C: 角に跨る [0.5,1.5]×[0.5,1.5] = 1
    //    C のうち未被覆は x∈[1,1.5] かつ y∈[1,1.5] の 0.25 だけ → 合計 4.25
    expect(
      unionAreaOfRects([rect(0, 0, 2, 1), rect(0, 0, 1, 3), rect(0.5, 0.5, 1.5, 1.5)])
    ).toBeCloseTo(4.25, 9);
  });

  it('内包された矩形は外側の面積のみ', () => {
    expect(unionAreaOfRects([rect(0, 0, 4, 4), rect(1, 1, 2, 3)])).toBeCloseTo(16, 9);
    // 順序を入れ替えても同じ
    expect(unionAreaOfRects([rect(1, 1, 2, 3), rect(0, 0, 4, 4)])).toBeCloseTo(16, 9);
  });

  it('空配列は0', () => {
    expect(unionAreaOfRects([])).toBe(0);
  });

  it('NaN/Infinity を含む矩形は無視される', () => {
    expect(
      unionAreaOfRects([
        rect(0, 0, 2, 3),
        rect(Number.NaN, 0, 5, 5),
        rect(0, 0, Number.POSITIVE_INFINITY, 5),
        rect(0, Number.NEGATIVE_INFINITY, 5, 5)
      ])
    ).toBeCloseTo(6, 9);
    // 全て無効なら0
    expect(unionAreaOfRects([rect(Number.NaN, Number.NaN, Number.NaN, Number.NaN)])).toBe(0);
  });

  it('面積0（線分・点）の矩形は無視される', () => {
    expect(unionAreaOfRects([rect(0, 0, 0, 5), rect(0, 0, 5, 0), rect(1, 1, 1, 1)])).toBe(0);
    expect(unionAreaOfRects([rect(0, 0, 2, 3), rect(0, 0, 0, 5)])).toBeCloseTo(6, 9);
  });

  it('反転した矩形（x0>x1 / y0>y1）も正規化して同じ面積', () => {
    expect(unionAreaOfRects([rect(2, 3, 0, 0)])).toBeCloseTo(6, 9);
    expect(unionAreaOfRects([rect(2, 2, 0, 0), rect(3, 3, 1, 1)])).toBeCloseTo(7, 9);
  });

  it('負座標や実寸(mm)スケールでも成立する', () => {
    expect(unionAreaOfRects([rect(-2, -2, 0, 0), rect(-1, -1, 1, 1)])).toBeCloseTo(7, 9);
    // 壁 2700×3600mm から開口2つ（重なりあり）を引くイメージ
    const openings = unionAreaOfRects([rect(0, 0, 1000, 2000), rect(500, 0, 1500, 1000)]);
    expect(openings).toBeCloseTo(1000 * 2000 + 1000 * 1000 - 500 * 1000, 6);
  });

  it('多数（10枚）の帯が全て重なっても1枚分', () => {
    const many = Array.from({ length: 10 }, () => rect(0, 0, 3, 2));
    expect(unionAreaOfRects(many)).toBeCloseTo(6, 9);
  });
});

// ---- ランダム性テスト（総当りのピクセル数え上げと突き合わせ） ----

/** 決定論的な擬似乱数（seed 固定＝CI で揺れない）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 総当り：バウンディングボックスを N×N のセルに切り、セル中心が和集合に入るセルを数える。
 * 返り値の tol は「セル中心サンプリングの誤差上界」。
 * 直交領域なので誤差は各辺がサンプリング線へスナップされる分＝
 *   Σ(水平辺長 × dy/2) + Σ(垂直辺長 × dx/2)
 * で厳密に抑えられる（矩形の全辺長は和集合の境界長以上なので安全側）。
 */
function bruteForceUnionArea(
  rects: Rect[],
  n: number
): { area: number; tol: number } {
  if (rects.length === 0) return { area: 0, tol: 0 };
  const bx0 = Math.min(...rects.map((r) => r.x0));
  const bx1 = Math.max(...rects.map((r) => r.x1));
  const by0 = Math.min(...rects.map((r) => r.y0));
  const by1 = Math.max(...rects.map((r) => r.y1));
  const dx = (bx1 - bx0) / n;
  const dy = (by1 - by0) / n;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = bx0 + (i + 0.5) * dx;
    for (let j = 0; j < n; j++) {
      const y = by0 + (j + 0.5) * dy;
      for (const r of rects) {
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) {
          count++;
          break;
        }
      }
    }
  }
  let tol = 1e-9;
  for (const r of rects) {
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    tol += w * dy + h * dx; // = 2w*(dy/2) + 2h*(dx/2)
  }
  return { area: count * dx * dy, tol };
}

describe('unionAreaOfRects ランダム性テスト', () => {
  it('50パターンの乱数矩形集合で総当り(200×200グリッド)と一致する', () => {
    const rnd = mulberry32(20260728);
    const GRID = 200;
    let maxRelDiff = 0;
    for (let trial = 0; trial < 50; trial++) {
      const count = 1 + Math.floor(rnd() * 6); // 1〜6枚
      const rects: Rect[] = [];
      for (let k = 0; k < count; k++) {
        const x0 = rnd() * 8;
        const y0 = rnd() * 8;
        const w = 0.5 + rnd() * 3;
        const h = 0.5 + rnd() * 3;
        rects.push(rect(x0, y0, x0 + w, y0 + h));
      }
      const exact = unionAreaOfRects(rects);
      const { area, tol } = bruteForceUnionArea(rects, GRID);
      const diff = Math.abs(exact - area);
      expect(diff).toBeLessThanOrEqual(tol);
      // 和集合は「合計以下・最大矩形以上」という自明な不変条件も併せて確認
      const sum = rects.reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
      const biggest = Math.max(...rects.map((r) => (r.x1 - r.x0) * (r.y1 - r.y0)));
      expect(exact).toBeLessThanOrEqual(sum + 1e-9);
      expect(exact).toBeGreaterThanOrEqual(biggest - 1e-9);
      const rel = diff / Math.max(exact, 1e-9);
      if (rel > maxRelDiff) maxRelDiff = rel;
    }
    // seed 固定なので決定論的。200×200 グリッドの離散化誤差は面積比で数%以内に収まる。
    expect(maxRelDiff).toBeLessThan(0.03);
  });
});
