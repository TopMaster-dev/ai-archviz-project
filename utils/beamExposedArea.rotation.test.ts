// 260728 敵対検証で発見した重大バグの回帰テスト。
// 包除原理の深さ0で P に再クリップしていたため、辺を共有する遮蔽が浮動小数で消え、
// 面積が過大＝見積の水増しに一方向へ倒れていた（斜め角度でのみ発現し、軸平行の手計算テストでは検出不能だった）。
// 面積は回転不変なので「軸平行の正解を剛体回転しても一致する」ことで固定する。
import { describe, it, expect } from 'vitest';
import { areaOfPolyMinusUnion } from './beamExposedArea.js';

// 剛体回転で結果が変わらないこと（面積は回転不変）。辺共有ケースを全角度で検査する。
const rot = (p: {x:number;y:number}[], deg: number) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return p.map(({x,y}) => ({ x: x*c - y*s, y: x*s + y*c }));
};
const rect = (x0:number,y0:number,x1:number,y1:number) =>
  [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];

describe('areaOfPolyMinusUnion 回転不変性（辺共有ケース）', () => {
  it('L字コーナー: 全角度で同じ値', () => {
    const P = rect(0,0,4000,200);
    const Q = rect(0,0,200,3200);          // P と辺を共有（左端）
    const base = areaOfPolyMinusUnion(P, [Q]);
    expect(base).toBeCloseTo(4000*200 - 200*200, 6);
    let worst = 0;
    for (let d = 0; d <= 90; d += 0.25) {
      const v = areaOfPolyMinusUnion(rot(P,d), [rot(Q,d)]);
      worst = Math.max(worst, Math.abs(v - base));
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('井桁（4本が P と辺共有）: 全角度で同じ値', () => {
    const P = rect(0,0,4000,4000);
    const Qs = [rect(0,0,4000,200), rect(0,3800,4000,4000), rect(0,0,200,4000), rect(3800,0,4000,4000)];
    const base = areaOfPolyMinusUnion(P, Qs);
    expect(base).toBeCloseTo(3600*3600, 6);
    let worst = 0;
    for (let d = 0; d <= 90; d += 0.5) {
      const v = areaOfPolyMinusUnion(rot(P,d), Qs.map(q=>rot(q,d)));
      worst = Math.max(worst, Math.abs(v - base));
    }
    expect(worst / base).toBeLessThan(1e-6);
  });
});
