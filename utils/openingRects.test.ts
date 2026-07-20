import { describe, it, expect } from 'vitest';
import {
  placementsBBox,
  placementsArea,
  clipOpeningsToPlacements,
  dropImplausibleOpenings,
  dropCeilingArtifactOpenings,
  sanitizeDetectedOpenings,
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

describe('dropCeilingArtifactOpenings（天井際の誤検出フィルタ・260720）', () => {
  const wall = [rect(0.0, 0.0, 1.0, 1.0)]; // faceH=1, faceW=1

  it('壁の中ほどの本物の窓は残す', () => {
    const win = rect(0.35, 0.3, 0.25, 0.3); // bottomRel=0.6, hFrac=0.3, aspect≈0.83
    expect(dropCeilingArtifactOpenings([win], wall)).toEqual([win]);
  });

  it('床まで届く背の高いドア/窓は残す', () => {
    const door = rect(0.4, 0.4, 0.15, 0.6); // bottomRel=1.0
    expect(dropCeilingArtifactOpenings([door], wall)).toEqual([door]);
  });

  it('(1) 天井際スライバー（開口全体が上端の細い帯）は落とす＝コーブ/LED帯の誤検出', () => {
    const cove = rect(0.2, 0.03, 0.5, 0.06); // bottomRel=0.09 ≤ 0.18
    expect(dropCeilingArtifactOpenings([cove], wall)).toEqual([]);
  });

  it('(2) 上部の薄い横帯（見切り/モールディング）は落とす', () => {
    const band = rect(0.1, 0.1, 0.5, 0.1); // bottomRel=0.2(>0.18), topRel=0.1, hFrac=0.1(<0.12), aspect=5(>3)
    expect(dropCeilingArtifactOpenings([band], wall)).toEqual([]);
  });

  it('上寄りでも十分な高さがあれば残す（薄くない＝本物の高窓）', () => {
    const highWin = rect(0.1, 0.1, 0.2, 0.35); // hFrac=0.35(>0.12), bottomRel=0.45(>0.18)
    expect(dropCeilingArtifactOpenings([highWin], wall)).toEqual([highWin]);
  });

  it('下部の薄い横帯（腰高の帯等）は落とさない＝天井際の誤検出だけを狙う', () => {
    const lowBand = rect(0.1, 0.7, 0.6, 0.1); // topRel=0.7(>0.35) → ルール2非該当・bottomRel=0.8 → ルール1非該当
    expect(dropCeilingArtifactOpenings([lowBand], wall)).toEqual([lowBand]);
  });

  it('やや厚い天井際パッチ（上端30%以内に収まる）も落とす（260720 しきい値強化）', () => {
    // 薄帯より厚め（h=0.16）だが下端 0.24 ≤ 0.30 → 天井際バンドで落とす（旧 0.18 では取りこぼしていたケース）。
    const patch = rect(0.08, 0.08, 0.4, 0.16);
    expect(dropCeilingArtifactOpenings([patch], wall)).toEqual([]);
  });

  it('中ほどまで下がる窓は上端付近から始まっても残す（下端が30%超）', () => {
    // 上端 0.25 から始まるが下端 0.5（>0.30）→ 天井際バンド非該当。高さ十分（0.25>0.20）→ 薄帯ルール非該当。
    const win = rect(0.2, 0.25, 0.3, 0.25);
    expect(dropCeilingArtifactOpenings([win], wall)).toEqual([win]);
  });

  it('面が退化なら素通し（判定不能なら落とさない）', () => {
    const o = [rect(0.2, 0.02, 0.5, 0.05)];
    expect(dropCeilingArtifactOpenings(o, [])).toEqual(o);
  });
});

describe('sanitizeDetectedOpenings（クリップ→面積→幾何の一本化・260720）', () => {
  const wall = [rect(0.0, 0.0, 1.0, 1.0)];

  it('本物の窓は残し、天井際の誤検出だけ落とす', () => {
    const win = rect(0.35, 0.3, 0.25, 0.3);
    const cove = rect(0.2, 0.03, 0.5, 0.06);
    expect(sanitizeDetectedOpenings([win, cove], wall)).toEqual([win]);
  });

  it('未検出/空は空配列', () => {
    expect(sanitizeDetectedOpenings(undefined, wall)).toEqual([]);
    expect(sanitizeDetectedOpenings([], wall)).toEqual([]);
  });

  it('面のほとんどを覆う非現実的検出は面積バックストップで落ちる', () => {
    const huge = rect(0.05, 0.05, 0.9, 0.9); // 0.81 > 0.7
    expect(sanitizeDetectedOpenings([huge], wall)).toEqual([]);
  });
});
