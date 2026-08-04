import { describe, it, expect } from 'vitest';
import {
  beamTouchesCeiling,
  beamCeilingCoverM2,
  wallBeamCoverStrip,
  freeBeamCoverStrip,
  wallBeamCoverUnionM2,
} from './beamSurfaceCover.js';
import { wallBeamWallCoverAreaM2, freeBeamWallCoverAreaM2 } from './beamArea.js';
import type { Beam } from '../lib/project/projectState.js';

/** 十分に広い部屋（下のケースはすべて室内に収まる）。 */
const BIG_ROOM = [
  { x: -50000, y: -50000 },
  { x: 50000, y: -50000 },
  { x: 50000, y: 50000 },
  { x: -50000, y: 50000 },
];

/**
 * 梁が接している面の側の控除（260808 クライアント要望③）。
 *
 * 「梁が重なった部分の面積が除外できていない」というご指摘の実体は2つ:
 *  (A) 天井が梁の裏を一切引いていない（＝過大計上）
 *  (B) 壁は梁ごとに引いていたので、重なると同じ面積を2回引く（＝過小計上）
 * どちらも「和集合になっていない」ことが原因なので、重なりを1回だけ数える。
 */

const mk = (o: Partial<Beam> & { id: string }): Beam => ({
  id: o.id,
  cx: o.cx ?? 0,
  cy: o.cy ?? 0,
  lengthMm: o.lengthMm ?? 4000,
  angleDeg: o.angleDeg ?? 0,
  widthMm: o.widthMm ?? 200,
  dropMm: o.dropMm ?? 0,
  heightMm: o.heightMm ?? 300,
  ...(o.wallIndex !== undefined ? { wallIndex: o.wallIndex } : {}),
});

describe('天井に接しているかの判定', () => {
  it('下がり0は天井に密着（天井から差し引く）', () => {
    expect(beamTouchesCeiling({ dropMm: 0 })).toBe(true);
  });

  it('下がりがあれば天井との間にすき間があるので差し引かない', () => {
    // クライアント確認済み: 下がりのある梁は天井面をそのまま計上する。
    expect(beamTouchesCeiling({ dropMm: 1 })).toBe(false);
    expect(beamTouchesCeiling({ dropMm: 150 })).toBe(false);
  });

  it('下がり未設定は0とみなす', () => {
    expect(beamTouchesCeiling({ dropMm: undefined as unknown as number })).toBe(true);
  });
});

describe('天井が梁に覆われる面積', () => {
  it('梁1本は 長さ×幅', () => {
    expect(beamCeilingCoverM2([mk({ id: 'A' })], BIG_ROOM)).toBeCloseTo((4000 * 200) / 1e6, 9);
  });

  it('直交する2本は重なりを1回だけ数える', () => {
    // 0.8 + 0.8 − 0.04（交差の 200×200）= 1.56
    const cover = beamCeilingCoverM2([mk({ id: 'A', angleDeg: 0 }), mk({ id: 'B', angleDeg: 90 })], BIG_ROOM);
    expect(cover).toBeCloseTo(1.56, 9);
    // 単純合計（＝二重に引いてしまう値）より必ず小さい。
    expect(cover).toBeLessThan(1.6);
  });

  it('3本以上が同じ場所で重なっても引きすぎない', () => {
    const three = beamCeilingCoverM2([
      mk({ id: 'A', angleDeg: 0 }),
      mk({ id: 'B', angleDeg: 90 }),
      mk({ id: 'C', angleDeg: 45 }),
    ], BIG_ROOM);
    // 和集合なので単純合計 2.4 を必ず下回り、かつ2本のときより広い。
    expect(three).toBeLessThan(2.4);
    expect(three).toBeGreaterThan(1.56);
  });

  it('完全に重なった2本は1本ぶん', () => {
    const one = beamCeilingCoverM2([mk({ id: 'A' })], BIG_ROOM);
    expect(beamCeilingCoverM2([mk({ id: 'A' }), mk({ id: 'B' })], BIG_ROOM)).toBeCloseTo(one, 9);
  });

  it('離れた2本は単純合計と一致する', () => {
    expect(beamCeilingCoverM2([mk({ id: 'A', cx: 0 }), mk({ id: 'B', cx: 20000 })], BIG_ROOM)).toBeCloseTo(1.6, 9);
  });

  it('下がりのある梁は数えない', () => {
    expect(beamCeilingCoverM2([mk({ id: 'A', dropMm: 150 })], BIG_ROOM)).toBe(0);
    // 密着1本＋下がり1本 → 密着ぶんだけ
    expect(beamCeilingCoverM2([mk({ id: 'A' }), mk({ id: 'B', angleDeg: 90, dropMm: 150 })], BIG_ROOM)).toBeCloseTo(0.8, 9);
  });

  it('梁が無い・寸法が壊れているときは 0', () => {
    expect(beamCeilingCoverM2([], BIG_ROOM)).toBe(0);
    expect(beamCeilingCoverM2([mk({ id: 'A', lengthMm: 0 })], BIG_ROOM)).toBe(0);
    expect(beamCeilingCoverM2([mk({ id: 'A', widthMm: NaN })], BIG_ROOM)).toBe(0);
    expect(beamCeilingCoverM2([mk({ id: 'A', cx: NaN })], BIG_ROOM)).toBe(0);
  });

  it('格子状に組んでも天井が負にならない（過剰控除しない）', () => {
    const ceiling = (6000 * 5000) / 1e6;
    const cover = beamCeilingCoverM2([
      mk({ id: 'A', angleDeg: 0, cy: -1500 }),
      mk({ id: 'B', angleDeg: 0, cy: 0 }),
      mk({ id: 'C', angleDeg: 0, cy: 1500 }),
      mk({ id: 'D', angleDeg: 90, cx: -1000, lengthMm: 5000 }),
      mk({ id: 'E', angleDeg: 90, cx: 1000, lengthMm: 5000 }),
    ], BIG_ROOM);
    expect(cover).toBeGreaterThan(0);
    expect(cover).toBeLessThan(ceiling);
    // 単純合計 4.4 より小さい＝重なり分を1回だけ数えている。
    expect(cover).toBeLessThan(4.4);
  });
});

/**
 * 帯の面積は従来の1本ぶきの計算と一致していなければならない。
 * ここがずれると、和集合化と同時に既存の壁面積まで動いてしまう。
 */
describe('壁の帯は従来の面積計算と一致する（1本のとき）', () => {
  const roomH = 2700;
  const P1 = { x: -3000, y: -2500 };
  const P2 = { x: 3000, y: -2500 };

  const stripAreaM2 = (r: ReturnType<typeof wallBeamCoverStrip>) =>
    r ? ((r.x1 - r.x0) * (r.y1 - r.y0)) / 1e6 : 0;

  it('壁梁: 下がり無し / 有り / 壁区画で切れる場合', () => {
    for (const [drop, bottom, top] of [
      [0, 0, roomH],
      [200, 0, roomH],
      [0, 900, roomH],
      [0, 0, 900],
    ] as const) {
      const b = mk({ id: 'W', wallIndex: 1, lengthMm: 3000, heightMm: 300, dropMm: drop });
      expect(stripAreaM2(wallBeamCoverStrip(b, bottom, top, roomH))).toBeCloseTo(
        wallBeamWallCoverAreaM2(b, bottom, top, roomH),
        9,
      );
    }
  });

  it('壁梁でない梁は帯を作らない', () => {
    expect(wallBeamCoverStrip(mk({ id: 'F' }), 0, roomH, roomH)).toBeNull();
  });

  it('自由梁: 壁沿い / 離れている / 直交', () => {
    const cases: Beam[] = [
      mk({ id: 'F1', cx: 0, cy: -2400, angleDeg: 0, lengthMm: 6000 }), // 壁沿い
      mk({ id: 'F2', cx: 0, cy: 0, angleDeg: 0, lengthMm: 6000 }), // 壁から離れている
      mk({ id: 'F3', cx: 0, cy: -2400, angleDeg: 90, lengthMm: 4000 }), // 壁に直交
      mk({ id: 'F4', cx: -2000, cy: -2400, angleDeg: 0, lengthMm: 3000 }), // 部分的
    ];
    for (const b of cases) {
      expect(stripAreaM2(freeBeamCoverStrip(b, P1, P2, 0, roomH, roomH)), b.id).toBeCloseTo(
        freeBeamWallCoverAreaM2(b, P1, P2, 0, roomH, roomH),
        9,
      );
    }
  });

  it('壁梁は自由梁の判定に混ざらない', () => {
    expect(freeBeamCoverStrip(mk({ id: 'W', wallIndex: 0 }), P1, P2, 0, roomH, roomH)).toBeNull();
  });
});

describe('壁の控除は重なりを1回だけ数える', () => {
  const roomH = 2700;
  const P1 = { x: -3000, y: -2500 };
  const P2 = { x: 3000, y: -2500 };

  it('同じ帯を覆う壁梁と自由梁があっても二重に引かない', () => {
    const wall = mk({ id: 'W', wallIndex: 0, lengthMm: 6000, heightMm: 300 });
    const free = mk({ id: 'F', cx: 0, cy: -2400, angleDeg: 0, lengthMm: 6000, heightMm: 300 });
    const a = wallBeamWallCoverAreaM2(wall, 0, roomH, roomH);
    const b = freeBeamWallCoverAreaM2(free, P1, P2, 0, roomH, roomH);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);

    const union = wallBeamCoverUnionM2([
      wallBeamCoverStrip(wall, 0, roomH, roomH),
      freeBeamCoverStrip(free, P1, P2, 0, roomH, roomH),
    ]);
    // 従来は a + b を引いていた（＝同じ帯を2回）。和集合は重なりを1回だけ数える。
    expect(union).toBeLessThan(a + b);
    expect(union).toBeCloseTo(Math.max(a, b), 9);
  });

  it('重ならない帯は単純合計と一致する', () => {
    const upper = wallBeamCoverStrip(mk({ id: 'A', wallIndex: 0, lengthMm: 6000, heightMm: 300 }), 0, roomH, roomH);
    // 別の高さ帯（下がりを大きく取って下側へ）
    const lower = wallBeamCoverStrip(
      mk({ id: 'B', wallIndex: 0, lengthMm: 6000, heightMm: 300, dropMm: 1000 }),
      0,
      roomH,
      roomH,
    );
    const union = wallBeamCoverUnionM2([upper, lower]);
    expect(union).toBeCloseTo((6000 * 300) / 1e6 + (6000 * 300) / 1e6, 9);
  });

  it('帯が無い・壊れているときは 0', () => {
    expect(wallBeamCoverUnionM2([])).toBe(0);
    expect(wallBeamCoverUnionM2([null, null])).toBe(0);
    expect(wallBeamCoverUnionM2([{ x0: 0, x1: 0, y0: 0, y1: 100 }])).toBe(0);
    expect(wallBeamCoverUnionM2([{ x0: 0, x1: NaN, y0: 0, y1: 100 }])).toBe(0);
  });
});

/**
 * 天井の控除は「部屋の内側」だけを数える（敵対レビューで見つかった不具合）。
 *
 * 自由梁は室内に制限されておらず、天伏図の空白部クリックやX/Y入力で部屋の外にも置ける。
 * footprint をそのまま引いていたため、天井に掛かっていない梁で天井面積が減っていた。
 */
describe('天井の控除は部屋の内側だけ', () => {
  // 6m×5m の部屋（原点中心）
  const ROOM = [
    { x: -3000, y: -2500 },
    { x: 3000, y: -2500 },
    { x: 3000, y: 2500 },
    { x: -3000, y: 2500 },
  ];

  it('部屋の外にある梁は天井を減らさない', () => {
    const outside = mk({ id: 'OUT', cx: 20000, cy: 20000, lengthMm: 2000, widthMm: 150 });
    expect(beamCeilingCoverM2([outside], ROOM)).toBe(0);
  });

  it('半分はみ出した梁は室内側だけ数える', () => {
    // 幅150の梁を壁(x=3000)にまたがせる: 長さ2000のうち室内は1000。
    const half = mk({ id: 'H', cx: 3000, cy: 0, angleDeg: 0, lengthMm: 2000, widthMm: 150 });
    const cover = beamCeilingCoverM2([half], ROOM);
    expect(cover).toBeCloseTo((1000 * 150) / 1e6, 9);
    // 室内外を区別せず引いていた頃の値（全長ぶん）より小さい。
    expect(cover).toBeLessThan((2000 * 150) / 1e6);
  });

  it('完全に室内の梁は従来どおり全面を数える', () => {
    const inside = mk({ id: 'IN', cx: 0, cy: 0, lengthMm: 2000, widthMm: 150 });
    expect(beamCeilingCoverM2([inside], ROOM)).toBeCloseTo((2000 * 150) / 1e6, 9);
  });

  it('L字の部屋: 欠けた部分に掛かる梁はその分を数えない', () => {
    // 8m×6m から右下 4m×3m を欠くL字。
    const L = [
      { x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 3000 },
      { x: 4000, y: 3000 }, { x: 4000, y: 6000 }, { x: 0, y: 6000 },
    ];
    // y=4500 の高さで x=0..8000 に渡す梁。室内は x=0..4000 だけ。
    const beam = mk({ id: 'L1', cx: 4000, cy: 4500, angleDeg: 0, lengthMm: 8000, widthMm: 200 });
    expect(beamCeilingCoverM2([beam], L)).toBeCloseTo((4000 * 200) / 1e6, 6);
  });

  it('室内の重なりは1回だけ数えたまま（クリップで壊れていない）', () => {
    const cover = beamCeilingCoverM2(
      [mk({ id: 'A', angleDeg: 0, lengthMm: 4000 }), mk({ id: 'B', angleDeg: 90, lengthMm: 4000 })],
      ROOM,
    );
    expect(cover).toBeCloseTo(1.56, 6);
  });

  it('部屋の形が取れないときは控除しない（安全側）', () => {
    expect(beamCeilingCoverM2([mk({ id: 'A' })], [])).toBe(0);
    expect(beamCeilingCoverM2([mk({ id: 'A' })], [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
  });

  it('控除が部屋の面積を超えない', () => {
    const roomArea = (6000 * 5000) / 1e6;
    const huge = mk({ id: 'BIG', cx: 0, cy: 0, lengthMm: 100000, widthMm: 100000 });
    expect(beamCeilingCoverM2([huge], ROOM)).toBeCloseTo(roomArea, 6);
  });
});
