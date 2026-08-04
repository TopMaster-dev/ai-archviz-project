/**
 * 単純多角形（自己交差なし）を三角形へ分割する（耳切り法）。
 *
 * なぜ必要か: 面の重なり計算は「凸多角形どうしの交差」で組み立てている
 * （utils/beamExposedArea.ts の convexIntersectionPolygon）。部屋はL字などの凹多角形になり得るため、
 * そのままでは「部屋の内側だけ」を切り出せない。三角形はすべて凸なので、
 * 部屋を三角形へ分けてしまえば既存の凸どうしの交差だけで厳密に扱える。
 *
 * 単位はどれでもよい（呼び出し側の座標系のまま）。
 */

export interface Pt {
  x: number;
  y: number;
}

function signedArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** 三角形 abc（CCW前提）の内側に p があるか（辺上は内側扱い）。 */
function pointInTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const cross = (o: Pt, s: Pt, t: Pt) => (s.x - o.x) * (t.y - o.y) - (s.y - o.y) * (t.x - o.x);
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

/**
 * 多角形を三角形リストへ分割する。頂点が3未満・面積0なら空配列。
 *
 * 耳が見つからなくなった場合（数値誤差・自己交差など）は、残りを扇状に切って打ち切る。
 * 面積計算に使うため「必ず何かを返して落ちない」ことを優先する
 * （ここで例外を投げると、見積画面が丸ごと表示できなくなる）。
 */
export function triangulatePolygon(polygon: readonly Pt[]): Pt[][] {
  if (!polygon || polygon.length < 3) return [];
  const pts = polygon.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return [];
  // 反時計回りへ揃える（内側判定の向きを一定にする）。
  const ring = signedArea(pts) < 0 ? [...pts].reverse() : [...pts];
  if (Math.abs(signedArea(ring)) <= 1e-9) return [];

  const idx = ring.map((_, i) => i);
  const out: Pt[][] = [];
  let guard = ring.length * ring.length + 16;

  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k - 1 + idx.length) % idx.length];
      const ib = idx[k];
      const ic = idx[(k + 1) % idx.length];
      const a = ring[ia];
      const b = ring[ib];
      const c = ring[ic];
      // 凸でない頂点（反射頂点）は耳にならない。
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 0) continue;
      // 他の頂点を含んでいたら耳ではない。
      let contains = false;
      for (const im of idx) {
        if (im === ia || im === ib || im === ic) continue;
        if (pointInTriangle(ring[im], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // 耳が見つからない → 下の扇分割で残りを処理
  }

  if (idx.length === 3) {
    out.push([ring[idx[0]], ring[idx[1]], ring[idx[2]]]);
  } else if (idx.length > 3) {
    // 打ち切り時の保険（凹多角形では厳密でないが、面積が0になって黙って消えるよりはよい）。
    for (let k = 1; k + 1 < idx.length; k++) {
      out.push([ring[idx[0]], ring[idx[k]], ring[idx[k + 1]]]);
    }
  }
  return out.filter((t) => Math.abs(signedArea(t)) > 1e-9);
}
