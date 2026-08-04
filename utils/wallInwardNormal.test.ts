import { describe, it, expect } from 'vitest';
import { getRoomTransform, getWallRotationY, mmToScaled } from './sketchTransform.js';

/**
 * 壁ローカル +Z は常に室内を向く、という不変条件を固定する（260809）。
 *
 * RoomViewer はこの前提で WALL_LOCAL_PLUS_Z_IS_INDOOR = true とし、内向き法線を
 * 巻き方向だけから決めている。この法線が反転すると、
 *  ・カットアウェイ（手前の壁を消す判定）
 *  ・窓/ドアの表示・オフセット
 *  ・ドアの開き勝手
 * がまとめて裏返る（クライアント報告「一部の面の表示が反転する」）。
 *
 * 以前は「原点の方向＝室内」で判定していたが、原点は間取りの外接矩形の中心であって
 * 部屋の重心ではなく、凹んだ間取りでは室外に出る。さらにT字のように原点が室内にあっても
 * 「一点の方向」は凹多角形の内外判定として成立しない。ここでは点の内外判定を正解として、
 * 巻き方向由来の法線が全形状・両巻き方向で内向きになることを確かめる。
 */

/** (0,0,1) を Y 軸まわりに rotationY 回した (x,z)。RoomViewer の wallLocalPlusZ と同じ。 */
const localPlusZ = (rotationY: number) => ({ x: Math.sin(rotationY), z: Math.cos(rotationY) });

/** 点が多角形の内側か（レイキャスト法）。 */
function pointInPoly(pt: { x: number; z: number }, poly: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.z > pt.z) !== (b.z > pt.z) && pt.x < ((b.x - a.x) * (pt.z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** sketch座標(mm) → RoomViewer が使う mPoints（メートル・外接矩形中心が原点）。 */
function toMPoints(sketchPtsMm: { x: number; y: number }[]) {
  const scaled = sketchPtsMm.map((p) => ({ x: mmToScaled(p.x), y: mmToScaled(p.y) }));
  return getRoomTransform(scaled as never);
}

const SHAPES: Record<string, { x: number; y: number }[]> = {
  長方形: [
    { x: 0, y: 0 },
    { x: 6000, y: 0 },
    { x: 6000, y: 5000 },
    { x: 0, y: 5000 },
  ],
  L字: [
    { x: 0, y: 0 },
    { x: 8000, y: 0 },
    { x: 8000, y: 2000 },
    { x: 3000, y: 2000 },
    { x: 3000, y: 6000 },
    { x: 0, y: 6000 },
  ],
  コの字: [
    { x: 0, y: 0 },
    { x: 9000, y: 0 },
    { x: 9000, y: 6000 },
    { x: 6000, y: 6000 },
    { x: 6000, y: 2500 },
    { x: 3000, y: 2500 },
    { x: 3000, y: 6000 },
    { x: 0, y: 6000 },
  ],
  T字: [
    { x: 0, y: 0 },
    { x: 9000, y: 0 },
    { x: 9000, y: 2000 },
    { x: 6000, y: 2000 },
    { x: 6000, y: 7000 },
    { x: 3000, y: 7000 },
    { x: 3000, y: 2000 },
    { x: 0, y: 2000 },
  ],
};

/** 各壁について、ローカル +Z 方向へ少し進んだ点が室内にあるか調べる。 */
function wallsWhereLocalPlusZPointsOutside(sketchPtsMm: { x: number; y: number }[]): number[] {
  const { mPoints, isCCW } = toMPoints(sketchPtsMm);
  const poly = mPoints as unknown as { x: number; z: number }[];
  const bad: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const next = poly[(i + 1) % poly.length];
    const n = localPlusZ(getWallRotationY(p as never, next as never, isCCW));
    // 壁中心から法線方向へ 10mm。壁の厚みより十分小さく、隣の壁には届かない距離。
    const probe = { x: (p.x + next.x) / 2 + n.x * 0.01, z: (p.z + next.z) / 2 + n.z * 0.01 };
    if (!pointInPoly(probe, poly)) bad.push(i);
  }
  return bad;
}

describe('壁ローカル +Z は常に室内を向く', () => {
  for (const [name, pts] of Object.entries(SHAPES)) {
    it(`${name}（描いた順）`, () => {
      expect(wallsWhereLocalPlusZPointsOutside(pts)).toEqual([]);
    });

    it(`${name}（逆巻き）`, () => {
      // 利用者がどちら回りに描いても成り立つこと（isCCW が吸収する）。
      expect(wallsWhereLocalPlusZPointsOutside([...pts].reverse())).toEqual([]);
    });
  }
});

/**
 * 旧実装（原点の方向で内外を決める）が実際に誤判定していたことを記録しておく。
 * 「凹んだ間取りでも大丈夫では」と元に戻されるのを防ぐための番人。
 */
describe('旧実装（原点方向で判定）は凹んだ間取りで壊れる', () => {
  function wallsMisjudgedByOldRule(sketchPtsMm: { x: number; y: number }[]): number[] {
    const { mPoints, isCCW } = toMPoints(sketchPtsMm);
    const poly = mPoints as unknown as { x: number; z: number }[];
    const bad: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const next = poly[(i + 1) % poly.length];
      const n = localPlusZ(getWallRotationY(p as never, next as never, isCCW));
      const cx = (p.x + next.x) / 2;
      const cz = (p.z + next.z) / 2;
      const len = Math.hypot(-cx, -cz) || 1;
      const oldSaysIndoor = (n.x * -cx + n.z * -cz) / len >= 0; // 旧: 原点方向との内積
      const truth = pointInPoly({ x: cx + n.x * 0.01, z: cz + n.z * 0.01 }, poly);
      if (oldSaysIndoor !== truth) bad.push(i);
    }
    return bad;
  }

  it('長方形では偶然一致していた（だから長く気付かれなかった）', () => {
    expect(wallsMisjudgedByOldRule(SHAPES.長方形)).toEqual([]);
  });

  it('L字では2面が反転していた', () => {
    expect(wallsMisjudgedByOldRule(SHAPES.L字)).toHaveLength(2);
  });

  it('コの字では3面が反転していた', () => {
    expect(wallsMisjudgedByOldRule(SHAPES.コの字)).toHaveLength(3);
  });

  it('T字は原点が室内にあるのに2面が反転していた（原点の内外は関係ない）', () => {
    const { mPoints } = toMPoints(SHAPES.T字);
    expect(pointInPoly({ x: 0, z: 0 }, mPoints as unknown as { x: number; z: number }[])).toBe(true);
    expect(wallsMisjudgedByOldRule(SHAPES.T字)).toHaveLength(2);
  });
});
