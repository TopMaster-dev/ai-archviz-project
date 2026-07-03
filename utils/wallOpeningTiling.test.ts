import { describe, it, expect } from 'vitest';
import { solidRectsForSegment, type LocalRect } from './wallOpeningTiling.js';

// 面積の合計（重なりが無い前提のタイル群の妥当性チェック用）。
const area = (rects: LocalRect[]) => rects.reduce((s, r) => s + (r.xR - r.xL) * (r.yT - r.yB), 0);
// 矩形群が互いに重ならないか（面積ベースの整合とあわせて非重複を担保）。
const noOverlap = (rects: LocalRect[]) => {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const ox = Math.min(a.xR, b.xR) - Math.max(a.xL, b.xL);
      const oy = Math.min(a.yT, b.yT) - Math.max(a.yB, b.yB);
      if (ox > 1e-6 && oy > 1e-6) return false;
    }
  }
  return true;
};

describe('solidRectsForSegment（壁セグメントの開口差し引きタイリング・260703）', () => {
  it('開口なし: セグメント全体の1枚', () => {
    const r = solidRectsForSegment(2, 1.2, []);
    expect(r).toEqual([{ xL: -2, xR: 2, yB: -1.2, yT: 1.2 }]);
  });

  it('全高をまたぐドア（上下端に接する）: 左右2本の柱に分断され、中央は開く', () => {
    // 幅4m・高さ2.4mのセグメント（halfW=2,halfH=1.2）。ドア幅0.9m中央、全高。
    const door: LocalRect = { xL: -0.45, xR: 0.45, yB: -1.2, yT: 1.2 };
    const r = solidRectsForSegment(2, 1.2, [door]);
    // 左柱と右柱の2枚のみ。中央(ドア列)は実体レンジが空。
    expect(r).toHaveLength(2);
    expect(r).toContainEqual({ xL: -2, xR: -0.45, yB: -1.2, yT: 1.2 });
    expect(r).toContainEqual({ xL: 0.45, xR: 2, yB: -1.2, yT: 1.2 });
    // ドア列の矩形は無い（中央が塞がっていない＝穴が貫通）。
    expect(r.some((x) => x.xL === -0.45 && x.xR === 0.45)).toBe(false);
    expect(noOverlap(r)).toBe(true);
    // 面積 = 全体 - ドア。
    expect(area(r)).toBeCloseTo(4 * 2.4 - 0.9 * 2.4, 6);
  });

  it('部分的な窓（腰上に台形なし・上下に実体が残る）: 左柱＋窓下＋窓上＋右柱の4枚', () => {
    // 窓 X[-0.6,0.6], Y[-0.4,0.5]（セグメント内・上下端に接しない）。
    const win: LocalRect = { xL: -0.6, xR: 0.6, yB: -0.4, yT: 0.5 };
    const r = solidRectsForSegment(2, 1.2, [win]);
    expect(noOverlap(r)).toBe(true);
    // 左柱・右柱（全高）＋窓下・窓上（窓X内）。
    expect(r).toContainEqual({ xL: -2, xR: -0.6, yB: -1.2, yT: 1.2 });
    expect(r).toContainEqual({ xL: 0.6, xR: 2, yB: -1.2, yT: 1.2 });
    expect(r).toContainEqual({ xL: -0.6, xR: 0.6, yB: -1.2, yT: -0.4 }); // 窓下
    expect(r).toContainEqual({ xL: -0.6, xR: 0.6, yB: 0.5, yT: 1.2 }); // 窓上
    expect(r).toHaveLength(4);
    expect(area(r)).toBeCloseTo(4 * 2.4 - 1.2 * 0.9, 6);
  });

  it('壁より広い開口: セグメント幅にクランプされる（左右柱なし・上下のみ実体）', () => {
    const wide: LocalRect = { xL: -5, xR: 5, yB: -0.3, yT: 0.3 };
    const r = solidRectsForSegment(2, 1.2, [wide]);
    expect(noOverlap(r)).toBe(true);
    // 全幅で下帯と上帯のみ。
    expect(r).toContainEqual({ xL: -2, xR: 2, yB: -1.2, yT: -0.3 });
    expect(r).toContainEqual({ xL: -2, xR: 2, yB: 0.3, yT: 1.2 });
    expect(r).toHaveLength(2);
  });

  it('全幅・全高の開口: 実体なし（空配列）', () => {
    const full: LocalRect = { xL: -2, xR: 2, yB: -1.2, yT: 1.2 };
    expect(solidRectsForSegment(2, 1.2, [full])).toEqual([]);
  });

  it('2つの窓: 各列で正しく上下に分割され、間に柱が残る', () => {
    const a: LocalRect = { xL: -1.5, xR: -0.8, yB: -0.4, yT: 0.4 };
    const b: LocalRect = { xL: 0.6, xR: 1.3, yB: -0.2, yT: 0.6 };
    const r = solidRectsForSegment(2, 1.2, [a, b]);
    expect(noOverlap(r)).toBe(true);
    expect(area(r)).toBeCloseTo(4 * 2.4 - 0.7 * 0.8 - 0.7 * 0.8, 6);
    // 2窓の間（X[-0.8,0.6]）は全高の実体が残る。
    expect(r).toContainEqual({ xL: -0.8, xR: 0.6, yB: -1.2, yT: 1.2 });
  });

  it('腰壁の分割線をまたぐドア: 下段・上段それぞれで境界まで貫通し継ぎ目の帯を残さない', () => {
    // 下段: halfH=0.45（0..900mmを中心化）。ドアは下段の全高をまたぐ → 下段は左右柱のみ、境界(上端)まで開く。
    const lowerDoor: LocalRect = { xL: -0.45, xR: 0.45, yB: -0.45, yT: 0.45 };
    const lower = solidRectsForSegment(2, 0.45, [lowerDoor]);
    expect(lower).toHaveLength(2);
    // 下段の実体はドア上端(=分割線)まで到達（yT=0.45）＝境界に極薄帯を残さない。
    expect(lower.every((x) => x.yT === 0.45 && x.yB === -0.45)).toBe(true);

    // 上段: halfH=0.75（900..2400mm相当）。ドアは下端(分割線)から高さ2000mmまで → 上段の下端から途中まで開く。
    const upperDoor: LocalRect = { xL: -0.45, xR: 0.45, yB: -0.75, yT: -0.15 };
    const upper = solidRectsForSegment(2, 0.75, [upperDoor]);
    expect(noOverlap(upper)).toBe(true);
    // ドア列は下端(-0.75)から-0.15まで開き、その上(-0.15..0.75)に実体が残る。
    expect(upper).toContainEqual({ xL: -0.45, xR: 0.45, yB: -0.15, yT: 0.75 });
    // 左右柱は全高。
    expect(upper).toContainEqual({ xL: -2, xR: -0.45, yB: -0.75, yT: 0.75 });
    expect(upper).toContainEqual({ xL: 0.45, xR: 2, yB: -0.75, yT: 0.75 });
  });

  it('X方向に重なりY方向にずれた2開口: 和集合を差し引き重複なし', () => {
    // a,b は X[0,0.5] で重なり、その領域の Y は [0.1,0.3] で重複（面積0.1）。
    const a: LocalRect = { xL: -1, xR: 0.5, yB: -1.2, yT: 0.3 };
    const b: LocalRect = { xL: 0, xR: 1, yB: 0.1, yT: 1.2 };
    const r = solidRectsForSegment(2, 1.2, [a, b]);
    expect(noOverlap(r)).toBe(true);
    const unionArea = 1.5 * 1.5 + 1.0 * 1.1 - 0.5 * 0.2; // a + b - 重複
    expect(area(r)).toBeCloseTo(4 * 2.4 - unionArea, 6);
  });

  it('X方向に内包する2開口（広く低い＋狭く全高）: 内側X列は全開・外側は帯が残る', () => {
    const wide: LocalRect = { xL: -1.5, xR: 1.5, yB: -0.3, yT: 0.3 };
    const tallNarrow: LocalRect = { xL: -0.5, xR: 0.5, yB: -1.2, yT: 1.2 };
    const r = solidRectsForSegment(2, 1.2, [wide, tallNarrow]);
    expect(noOverlap(r)).toBe(true);
    // 内側X列[-0.5,0.5]は全高開放 → 実体矩形は無い。
    expect(r.some((x) => Math.abs(x.xL - -0.5) < 1e-9 && Math.abs(x.xR - 0.5) < 1e-9)).toBe(false);
    const unionArea = 3.0 * 0.6 + 1.0 * 2.4 - 1.0 * 0.6; // wide + tall - 重複
    expect(area(r)).toBeCloseTo(4 * 2.4 - unionArea, 6);
  });

  it('退化入力（幅ゼロ/高さゼロのセグメント）は空配列', () => {
    expect(solidRectsForSegment(0, 1, [])).toEqual([]);
    expect(solidRectsForSegment(1, 0, [])).toEqual([]);
  });

  it('極小開口も欠かさず差し引く（従来のMIN閾値ドロップは無い）', () => {
    const tiny: LocalRect = { xL: -0.02, xR: 0.02, yB: -1.2, yT: 1.2 };
    const r = solidRectsForSegment(2, 1.2, [tiny]);
    // 極小でも左右柱に分断され、面積は全体-極小開口。
    expect(area(r)).toBeCloseTo(4 * 2.4 - 0.04 * 2.4, 6);
    expect(noOverlap(r)).toBe(true);
  });
});
