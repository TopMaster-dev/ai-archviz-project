import { describe, it, expect } from 'vitest';
import {
  placementsBBox,
  placementsArea,
  clipOpeningsToPlacements,
  dropImplausibleOpenings,
} from './openingRects.js';
import type { NormalizedRect } from '../types.js';

const rect = (x: number, y: number, width: number, height: number): NormalizedRect => ({ x, y, width, height });

const expectBBoxClose = (
  bb: { x0: number; y0: number; x1: number; y1: number } | null,
  exp: { x0: number; y0: number; x1: number; y1: number }
) => {
  expect(bb).not.toBeNull();
  expect(bb!.x0).toBeCloseTo(exp.x0, 6);
  expect(bb!.y0).toBeCloseTo(exp.y0, 6);
  expect(bb!.x1).toBeCloseTo(exp.x1, 6);
  expect(bb!.y1).toBeCloseTo(exp.y1, 6);
};

describe('placementsBBox', () => {
  it('矩形の外接矩形を返す', () => {
    expectBBoxClose(placementsBBox([rect(0.1, 0.2, 0.3, 0.4)]), { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.6 });
  });
  it('複数矩形を包む', () => {
    // rect(0.5,0.6,0.1,0.1) の右下端は (0.6, 0.7)。全体の外接矩形は x1=0.6, y1=0.7。
    const bb = placementsBBox([rect(0.1, 0.1, 0.2, 0.2), rect(0.5, 0.6, 0.1, 0.1)]);
    expectBBoxClose(bb, { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.7 });
  });
  it('多角形は頂点で包む（x/y/width/height ではなく points 基準）', () => {
    const poly: NormalizedRect = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      points: [
        { x: 0.2, y: 0.3 },
        { x: 0.8, y: 0.25 },
        { x: 0.7, y: 0.9 },
        { x: 0.15, y: 0.85 },
      ],
    };
    expect(placementsBBox([poly])).toEqual({ x0: 0.15, y0: 0.25, x1: 0.8, y1: 0.9 });
  });
  it('空/退化なら null', () => {
    expect(placementsBBox([])).toBeNull();
    expect(placementsBBox([rect(0.5, 0.5, 0, 0)])).toBeNull();
  });
});

describe('clipOpeningsToPlacements', () => {
  it('面の内側に完全に収まる開口はそのまま（no-op）', () => {
    const placements = [rect(0.1, 0.1, 0.6, 0.6)]; // 0.1..0.7
    const opening = rect(0.3, 0.3, 0.2, 0.2); // 0.3..0.5 内側
    expect(clipOpeningsToPlacements([opening], placements)).toEqual([opening]);
  });

  it('面からはみ出した開口は面の外接矩形へクリップされる（隣の面へ穴を空けない・F4）', () => {
    // 面A = 左壁 0.0..0.5、開口が右へ 0.6 まではみ出す → 0.5 でクリップ。
    const placementsA = [rect(0.0, 0.0, 0.5, 1.0)];
    const opening = rect(0.4, 0.2, 0.2, 0.3); // 0.4..0.6（0.5 を越える）
    const clipped = clipOpeningsToPlacements([opening], placementsA);
    expect(clipped).toHaveLength(1);
    expect(clipped[0].x).toBeCloseTo(0.4, 6);
    expect(clipped[0].width).toBeCloseTo(0.1, 6); // 0.4..0.5 に切り詰め（0.5 超過分を除去）
    expect(clipped[0].y).toBeCloseTo(0.2, 6);
    expect(clipped[0].height).toBeCloseTo(0.3, 6);
  });

  it('面と全く交差しない開口は落とす（隣の壁の窓が自分の面に穴を空けない）', () => {
    const placementsB = [rect(0.6, 0.0, 0.4, 1.0)]; // 右壁 0.6..1.0
    const openingOnA = rect(0.1, 0.2, 0.2, 0.3); // 左壁の窓 0.1..0.3 → B と交差なし
    expect(clipOpeningsToPlacements([openingOnA], placementsB)).toEqual([]);
  });

  it('クリップ後に極小になった開口は落とす', () => {
    const placements = [rect(0.0, 0.0, 0.5, 1.0)];
    const sliver = rect(0.499, 0.2, 0.2, 0.3); // 0.499..0.5 の幅 0.001 だけ交差 → 0.002 未満で落とす
    expect(clipOpeningsToPlacements([sliver], placements)).toEqual([]);
  });

  it('placements が空なら常に空（穴あけ対象なし）', () => {
    expect(clipOpeningsToPlacements([rect(0.3, 0.3, 0.2, 0.2)], [])).toEqual([]);
  });

  it('複数開口をそれぞれ独立にクリップ／取捨する', () => {
    const placements = [rect(0.0, 0.0, 0.5, 1.0)];
    const inside = rect(0.1, 0.1, 0.2, 0.2);
    const spill = rect(0.4, 0.4, 0.3, 0.2); // 0.4..0.7 → 0.4..0.5 にクリップ
    const outside = rect(0.8, 0.1, 0.1, 0.1); // 交差なし
    const res = clipOpeningsToPlacements([inside, spill, outside], placements);
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual(inside);
    expect(res[1].x).toBeCloseTo(0.4, 6);
    expect(res[1].width).toBeCloseTo(0.1, 6);
  });
});

describe('placementsArea', () => {
  it('矩形の面積は w*h の合計', () => {
    expect(placementsArea([rect(0.0, 0.0, 0.5, 0.4)])).toBeCloseTo(0.2, 6);
    expect(placementsArea([rect(0.0, 0.0, 0.5, 0.4), rect(0.5, 0.5, 0.2, 0.5)])).toBeCloseTo(0.3, 6);
  });
  it('多角形はシューレース面積（頂点順で符号に依存しない）', () => {
    const square: NormalizedRect = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.6 },
        { x: 0.1, y: 0.6 },
      ],
    };
    expect(placementsArea([square])).toBeCloseTo(0.4 * 0.5, 6); // 0.2
  });
  it('空/退化は 0', () => {
    expect(placementsArea([])).toBe(0);
    expect(placementsArea([rect(0.2, 0.2, 0, 0)])).toBe(0);
  });
});

describe('dropImplausibleOpenings（誤検出バックストップ・R2-1）', () => {
  const wall = [rect(0.0, 0.0, 1.0, 1.0)]; // 面積 1.0

  it('妥当な範囲の開口はそのまま残す（窓が面の一部）', () => {
    const openings = [rect(0.1, 0.1, 0.3, 0.3), rect(0.6, 0.1, 0.2, 0.3)]; // 0.09+0.06=0.15 < 0.7
    expect(dropImplausibleOpenings(openings, wall)).toEqual(openings);
  });

  it('面のほとんどを覆う非現実的な検出は丸ごと落とす（面全体が未仕上げになるのを防ぐ）', () => {
    const huge = [rect(0.05, 0.05, 0.9, 0.9)]; // 0.81 > 0.7 → 全部落とす
    expect(dropImplausibleOpenings(huge, wall)).toEqual([]);
  });

  it('しきい値ちょうど付近: 0.7 以下は残す / 0.7 超は落とす', () => {
    expect(dropImplausibleOpenings([rect(0, 0, 0.7, 1.0)], wall)).toHaveLength(1); // 0.7 ちょうどは残す（>のみ落とす）
    expect(dropImplausibleOpenings([rect(0, 0, 0.71, 1.0)], wall)).toEqual([]); // 0.71 は落とす
  });

  it('小さい面に対する相対比で判定する（絶対サイズではない）', () => {
    const smallWall = [rect(0.0, 0.0, 0.2, 0.2)]; // 面積 0.04
    const openingCoveringMost = [rect(0.0, 0.0, 0.19, 0.19)]; // 0.0361 / 0.04 = 0.9 > 0.7 → 落とす
    expect(dropImplausibleOpenings(openingCoveringMost, smallWall)).toEqual([]);
  });

  it('placements が退化なら素通し（分母0で誤爆しない）', () => {
    const o = [rect(0.1, 0.1, 0.2, 0.2)];
    expect(dropImplausibleOpenings(o, [])).toEqual(o);
  });
});
