// 梁の露出表面積を「立体の和（union）の外側に見えている面」として厳密に求める（260728 クライアント要望 #10/#11）。
//
// これまで（utils/beamArea.ts の beamExposedAreaM2 + utils/beamOverlap.ts の beamOverlapDeductionByIdM2）は
//   ・各梁を独立した箱として 上面(L×W) / 下面(L×W) / 側面(L×H) / 端面(W×H) を足し上げ
//   ・そのあと「ペア交差の水平面だけ」を 50/50 で控除
// していた。ここには確定した2つの欠陥がある:
//   (a) 交差する梁の内部に埋まった側面・端面が一切控除されない（＝見えない面を数量に計上している）
//   (b) 3本以上が同じ領域で重なると、ペア交差の単純合計は引きすぎる（包除原理の2項打ち切り）
// クライアントの言葉では「SketchUp のプッシュ/プルのように、裏面を除外する論理にできないか」。
// つまり欲しいのは「箱の表面積の合計」ではなく「くっついた1つの立体の、外に見えている面積」。
//
// そこで梁を鉛直プリズム（footprint 多角形 × 鉛直帯 [bottomMm, topMm]）としてモデル化し、
//   ・上面/下面 … 面の「すぐ上（すぐ下）」に他の梁の実体がある部分を除く。
//                 除く領域は凸多角形の集合なので、包除原理（交差は凸のまま＝繰り返しクリップ可）で厳密に出す。
//   ・側面     … 面を (s = 辺に沿った距離, y = 高さ) でパラメータ化すると、他の梁に埋まる領域は
//                 必ず「軸並行矩形」になる。その和集合を unionAreaOfRects（厳密）で取る。
//                 ＝3本以上が同じ場所に重なっても構造的に正しい（引きすぎが起こり得ない）。
// とする。梁1本ずつの内訳（見積の行ごとの数量）も必要なので、重なりは
// 「若い id が1回だけ持つ」互いに素な分解で配分する（合計は常に union の表面積に一致する）。
//
// 単位: 入力は mm、出力は m²（/1e6）。
// 注意: 壁との接触（壁梁の裏面）はここでは一切扱わない。旧 beamExposedAreaM2 の
//       wallIndex による sideFaces=1/endFaces=0 のハードコードは廃止し、壁の扱いは
//       呼び出し側（wallBeamWallCoverAreaM2 / freeBeamWallCoverAreaM2 と同じレイヤ）に任せる。

import type { Beam } from '../lib/project/projectState.js';
import { beamFootprintCornersMm, convexIntersectionAreaMm2 } from './beamOverlap.js';
import { unionAreaOfRects, type Rect } from './rectUnion.js';

export interface Pt {
  x: number;
  y: number;
}

/** 梁＝鉛直プリズム。poly は footprint の頂点(mm・回転可)、[bottomMm, topMm] は鉛直帯(mm)。 */
export interface BeamSolid {
  id: string;
  poly: Pt[];
  bottomMm: number;
  topMm: number;
}

/** 高さ・位置の同一視トレランス(mm)。1e-6mm = 1nm。 */
const EPS_MM = 1e-6;
/** 面積0とみなす閾値(mm²)。クリップで出る幅0のスライバを捨てるため。 */
const EPS_AREA_MM2 = 1e-6;
/** 方向ベクトルの平行判定（単位ベクトル同士の外積なので無次元）。 */
const EPS_DIR = 1e-12;
/**
 * 包除原理を適用する最大枚数。2^12 = 4096 部分集合が上限（枝刈りで実際は遥かに少ない）。
 * これを超えたら保守的フォールバックに切り替える（areaOfPolyMinusUnion のコメント参照）。
 */
const MAX_INCLUSION_EXCLUSION = 12;

function signedAreaMm2(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** 多角形の面積(mm²・巻き方向非依存)。beamOverlap.ts の signedAreaMm2 は module-private なので同式を持つ。 */
function polyAreaMm2(poly: Pt[]): number {
  if (!poly || poly.length < 3) return 0;
  return Math.abs(signedAreaMm2(poly));
}

/** 反時計回り（CCW）に正規化する（内側判定・外向き法線を一貫させるため）。 */
function ensureCCW(poly: Pt[]): Pt[] {
  return signedAreaMm2(poly) < 0 ? [...poly].reverse() : poly;
}

/** 線分 PQ と直線 AB の交点（Sutherland–Hodgman 用・平行なら Q を返す安全側）。beamOverlap.ts と同式。 */
function segmentLineIntersect(P: Pt, Q: Pt, A: Pt, B: Pt): Pt {
  const dx = Q.x - P.x;
  const dy = Q.y - P.y;
  const ex = B.x - A.x;
  const ey = B.y - A.y;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return Q;
  const t = ((A.x - P.x) * ey - (A.y - P.y) * ex) / denom;
  return { x: P.x + t * dx, y: P.y + t * dy };
}

/**
 * 2つの凸多角形の交差「多角形」を返す（交差なしは空配列）。
 * convexIntersectionAreaMm2（utils/beamOverlap.ts）と同一の Sutherland–Hodgman クリップで、
 * 面積ではなく多角形そのものを返すだけの版。包除原理で「交差の交差」を取るために必要。
 * ＝ polyAreaMm2(convexIntersectionPolygon(a, b)) は convexIntersectionAreaMm2(a, b) と一致する
 *    （テストで同値性を固定している）。
 */
export function convexIntersectionPolygon(a: Pt[], b: Pt[]): Pt[] {
  if (!a || !b || a.length < 3 || b.length < 3) return [];
  let output = ensureCCW(a);
  const clip = ensureCCW(b);
  // 内側判定の許容（260728 敵対検証）。
  // 梁の配置では「辺が同一直線上に重なる」構成（L字コーナー・井桁・壁沿い）が普通に起きる。
  // 判定が厳密な cross >= 0 だと、軸に平行でない角度で本来 0 の外積が -1e-13 等になり、
  // 同一直線上の頂点が「外側」と誤判定されて多角形が潰れる＝遮蔽を取りこぼし面積が過大になる。
  // 外積は「辺長 × 点までの距離」のスケールを持つので、許容も座標スケールに比例させる。
  let scale = 0;
  for (const p of output) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));
  for (const p of clip) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));
  const crossTol = -1e-9 * Math.max(1, scale) * Math.max(1, scale);
  for (let i = 0; i < clip.length; i++) {
    const A = clip[i];
    const B = clip[(i + 1) % clip.length];
    const ex = B.x - A.x;
    const ey = B.y - A.y;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const P = input[j];
      const Q = input[(j + 1) % input.length];
      // CCW の clip 辺 AB に対し、点が左側（内側）なら cross >= 0（許容付き）。
      const insideP = ex * (P.y - A.y) - ey * (P.x - A.x) >= crossTol;
      const insideQ = ex * (Q.y - A.y) - ey * (Q.x - A.x) >= crossTol;
      if (insideP) output.push(P);
      if (insideP !== insideQ) output.push(segmentLineIntersect(P, Q, A, B));
    }
    if (output.length === 0) return [];
  }
  return output.length >= 3 ? output : [];
}

/**
 * 凸多角形 P のうち、凸多角形群 Qs の「どれにも覆われていない」部分の面積(mm²)。
 *
 * A_k = P ∩ Q_k はいずれも凸なので、包除原理
 *   |∪A_k| = Σ|A_k| − Σ|A_k∩A_l| + Σ|A_k∩A_l∩A_m| − …
 * を「クリップを重ねる」だけで厳密に計算できる（凸∩凸は凸）。
 * ペア交差までで打ち切る従来方式は3枚以上の重なりで引きすぎるが、ここは全項を取るので正しい。
 * 空になった時点でその部分集合を含む上位集合も全て空なので、深さ優先＋枝刈りで実際の計算量は小さい。
 *
 * GUARD: 包除原理は部分集合数が指数（2^n）。非空な A_k が MAX_INCLUSION_EXCLUSION(=12) 本を超えたら
 * 厳密計算を諦め、保守的な見積 max(0, |P| − min(|P|, Σ|A_k|)) にフォールバックする。
 * Σ|A_k| は重なりを二重に数えるので「覆われ面積」を過大評価する ＝ 露出面積は実際より小さめに出る。
 * つまり「負にならない」「実際より露出を多く主張しない」安全側に倒れる（見積で多く請求しない）。
 */
export function areaOfPolyMinusUnion(P: Pt[], Qs: Pt[][]): number {
  const total = polyAreaMm2(P);
  if (!(total > EPS_AREA_MM2)) return 0;
  if (!Qs || Qs.length === 0) return total;

  // A_k = P ∩ Q_k。空（面積ほぼ0）のものは以降の全部分集合も空なので、この時点で捨てる＝最大の枝刈り。
  // 足切りには既存の厳密交差面積 convexIntersectionAreaMm2 をそのまま使う（同じクリップなので値は一致）。
  const pieces: Pt[][] = [];
  for (const Q of Qs) {
    if (!Q || Q.length < 3) continue;
    if (!(convexIntersectionAreaMm2(P, Q) > EPS_AREA_MM2)) continue;
    const clipped = convexIntersectionPolygon(P, Q);
    if (clipped.length >= 3) pieces.push(clipped);
  }
  if (pieces.length === 0) return total;

  if (pieces.length > MAX_INCLUSION_EXCLUSION) {
    // 指数爆発の回避（安全側フォールバック・上のコメント参照）。
    let sum = 0;
    for (const piece of pieces) sum += polyAreaMm2(piece);
    return Math.max(0, total - Math.min(total, sum));
  }

  let covered = 0;
  const walk = (start: number, current: Pt[], sign: number): void => {
    for (let k = start; k < pieces.length; k++) {
      const inter = convexIntersectionPolygon(current, pieces[k]);
      const area = polyAreaMm2(inter);
      if (!(area > EPS_AREA_MM2)) continue; // 空 → この枝の上位集合も全て空
      covered += sign * area;
      walk(k + 1, inter, -sign);
    }
  };
  // 深さ0では P に再クリップしない（260728 敵対検証で発見した重大バグの修正）。
  // A_k は既に P ∩ Q_k なので P ∩ A_k = A_k（数学的には恒等）だが、A_k の辺は P の辺と同一直線上に
  // なることが多い（L字コーナー・井桁・壁沿い＝実際の梁配置ではほぼ常に）。そこへ再クリップすると
  // Sutherland–Hodgman の内側判定（cross >= 0）が浮動小数の -1e-13 を「外側」と誤判定して多角形が
  // 面積0に潰れ、その遮蔽が「重なり無し」として丸ごと捨てられる。結果、共有領域が二重計上され
  // 露出面積が過大＝見積の水増しに一方向に倒れる（実測: 斜め角度で +0.32 m²、過小は0件）。
  // 各 A_k をそのまま起点にすれば、この不要かつ危険な再クリップが消える。
  for (let k = 0; k < pieces.length; k++) {
    const a = polyAreaMm2(pieces[k]);
    if (!(a > EPS_AREA_MM2)) continue;
    covered += a;
    walk(k + 1, pieces[k], -1);
  }

  // 浮動小数の誤差で covered が [0, total] を僅かに外れることがあるので丸め込む。
  const clamped = Math.min(total, Math.max(0, covered));
  return total - clamped;
}

/**
 * 線分 A→B を凸多角形 poly でクリップし、覆われる区間 [s0, s1]（s = A からの距離 mm）を返す。
 * 交差しない／長さ0なら null。Cyrus–Beck（凸の半平面クリップ）。
 * 境界は「内側」扱い（>=）。＝ 突き合わせ（梁の端面が隣の梁の面にぴったり接する）は
 * 立体の内部の接合面なので露出しない、という判定になる。
 */
function clipSegmentToConvex(a: Pt, b: Pt, poly: Pt[]): [number, number] | null {
  if (!poly || poly.length < 3) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const ux = dx / len;
  const uy = dy / len;
  const clip = ensureCCW(poly);
  let s0 = 0;
  let s1 = len;
  for (let i = 0; i < clip.length; i++) {
    const A = clip[i];
    const B = clip[(i + 1) % clip.length];
    let ex = B.x - A.x;
    let ey = B.y - A.y;
    const elen = Math.hypot(ex, ey);
    if (!(elen > 0)) continue; // 退化辺は無視
    ex /= elen;
    ey /= elen;
    // CCW の辺 AB に対し内側は左。f(X) = cross(e, X−A) は内側を正とする符号付き距離(mm)。
    const f0 = ex * (a.y - A.y) - ey * (a.x - A.x);
    const g = ex * uy - ey * ux; // s が 1mm 進むごとの f の増分
    if (Math.abs(g) <= EPS_DIR) {
      // 辺と平行。始点が外側なら線分全体が外側。辺の直線上（f0≒0）は内側扱い。
      if (f0 < -EPS_MM) return null;
      continue;
    }
    const hit = -f0 / g;
    if (g > 0) {
      if (hit > s0) s0 = hit; // 内側へ入る
    } else if (hit < s1) {
      s1 = hit; // 外側へ出る
    }
    if (!(s1 > s0)) return null;
  }
  if (!(s1 - s0 > 0)) return null;
  return [s0, s1];
}

/**
 * 側面1枚（footprint の辺 edgeA→edgeB を底辺とし、[selfBottom, selfTop] を高さとする鉛直面）のうち、
 * 他の梁の内部に埋まっていて見えない面積(mm²)。
 *
 * KEY: 面を (s = 辺に沿った距離, y = 高さ) でパラメータ化すると、梁 j に埋まる領域は
 *   s ∈ 「線分を j の footprint でクリップした区間」× y ∈ [max(selfBottom, j.bottom), min(selfTop, j.top)]
 * という軸並行矩形になる（j は鉛直プリズムなので断面が高さに依らない）。
 * よって全 j の矩形を集めて unionAreaOfRects に渡せば、3本以上が同じ場所に重なっても厳密。
 *
 * 注意: others に自分自身を含めてはいけない（自分の辺は自分の footprint 境界上にあり、全面が
 *       「埋まっている」と判定されてしまう）。
 */
export function occludedSideAreaMm2(
  edgeA: Pt,
  edgeB: Pt,
  selfBottom: number,
  selfTop: number,
  others: BeamSolid[],
): number {
  if (!Number.isFinite(selfBottom) || !Number.isFinite(selfTop)) return 0;
  if (!(selfTop - selfBottom > 0)) return 0;
  if (!edgeA || !edgeB) return 0;
  if (!Number.isFinite(edgeA.x) || !Number.isFinite(edgeA.y)) return 0;
  if (!Number.isFinite(edgeB.x) || !Number.isFinite(edgeB.y)) return 0;
  if (!others || others.length === 0) return 0;

  const rects: Rect[] = [];
  for (const other of others) {
    if (!other || !other.poly || other.poly.length < 3) continue;
    if (!Number.isFinite(other.bottomMm) || !Number.isFinite(other.topMm)) continue;
    // 鉛直に重ならない（積み重なり・別の高さ）なら別々の露出面。
    const y0 = Math.max(selfBottom, other.bottomMm);
    const y1 = Math.min(selfTop, other.topMm);
    if (!(y1 - y0 > 0)) continue;
    const span = clipSegmentToConvex(edgeA, edgeB, other.poly);
    if (!span) continue;
    rects.push({ x0: span[0], x1: span[1], y0, y1 });
  }
  return unionAreaOfRects(rects);
}

interface Prepared {
  id: string;
  index: number;
  poly: Pt[]; // CCW 正規化済み
  bottom: number;
  top: number;
  solid: BeamSolid;
}

/** 同一 id が混ざっても分解が破綻しないよう (id, 入力順) の辞書順で「若い方」を決める。 */
function hasPriority(self: Prepared, other: Prepared): boolean {
  if (self.id !== other.id) return self.id < other.id;
  return self.index < other.index;
}

/** 点 y のすぐ上（+EPS）に other の実体があるか。＝上面が埋まっているか。 */
function coversJustAbove(other: Prepared, y: number): boolean {
  const probe = y + EPS_MM;
  return other.bottom <= probe && other.top >= probe;
}

/** 点 y のすぐ下（−EPS）に other の実体があるか。＝下面が埋まっているか。 */
function coversJustBelow(other: Prepared, y: number): boolean {
  const probe = y - EPS_MM;
  return other.bottom <= probe && other.top >= probe;
}

/**
 * other が「self の辺と同一直線・同一の外向き法線」を持つ辺を含むか。
 * ＝2本の梁の側面が同じ平面で同じ向きを向いている（＝物理的には1枚の面）ケース。
 * 例: L字の隅で直交する2本の梁の、隅側の面。／同じ壁ラインに並べた2本の梁の面。
 * この場合はどちらか一方だけが計上する（hasPriority で若い id が持つ）。
 * 逆向き法線（＝突き合わせの接合面）はここでは false ＝ 両者とも「埋まっている」判定になり、
 * 接合面は誰も計上しない（立体の内部なので正しい）。
 * poly は CCW 前提（外向き法線は辺方向 u=(ux,uy) に対し (uy, −ux)）。
 */
function hasCoplanarSameNormalEdge(edgeA: Pt, edgeB: Pt, otherPolyCCW: Pt[]): boolean {
  const dx = edgeB.x - edgeA.x;
  const dy = edgeB.y - edgeA.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return false;
  const nx = dy / len;
  const ny = -dx / len; // 外向き法線
  for (let i = 0; i < otherPolyCCW.length; i++) {
    const C = otherPolyCCW[i];
    const D = otherPolyCCW[(i + 1) % otherPolyCCW.length];
    const ex = D.x - C.x;
    const ey = D.y - C.y;
    const elen = Math.hypot(ex, ey);
    if (!(elen > 0)) continue;
    const mx = ey / elen;
    const my = -ex / elen;
    if (Math.abs(mx - nx) + Math.abs(my - ny) > 1e-9) continue; // 法線の向きが違う
    // 同一直線か（self の辺の直線までの符号付き距離）
    if (Math.abs((C.x - edgeA.x) * nx + (C.y - edgeA.y) * ny) > EPS_MM) continue;
    return true;
  }
  return false;
}

function prepare(solids: BeamSolid[]): Prepared[] {
  const out: Prepared[] = [];
  solids.forEach((s, index) => {
    if (!s || !Array.isArray(s.poly) || s.poly.length < 3) return;
    if (!Number.isFinite(s.bottomMm) || !Number.isFinite(s.topMm)) return;
    if (!(s.topMm - s.bottomMm > 0)) return;
    for (const p of s.poly) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    }
    const poly = ensureCCW(s.poly);
    if (!(polyAreaMm2(poly) > EPS_AREA_MM2)) return;
    out.push({ id: s.id, index, poly, bottom: s.bottomMm, top: s.topMm, solid: { ...s, poly } });
  });
  return out;
}

/**
 * 梁ごとの露出表面積(m²)。全梁の合計は「梁の和集合立体の表面積」に一致する（重なりの二重計上なし）。
 *
 *  - 上面 : topMm < roomHeightMm − 1e-6（天井から下がっている）ときだけ計上。
 *           真上に実体がある梁（bottom_j ≦ top_i < top_j。積み重なりで bottom_j == top_i の接合面も含む）
 *           の footprint を除いた面積。
 *           上端の高さが完全に一致する梁同士（coincident face）は物理的に1枚の面なので、
 *           id の若い方（同 id なら入力順の早い方）が1回だけ計上する。
 *  - 下面 : bottomMm > 1e-6（床に達していない）ときだけ計上。上面と対称。
 *  - 側面 : footprint の各辺について |辺| × 高さ − occludedSideAreaMm2(…)。負にはしない。
 *           同一平面・同一向きの側面（L字の隅など）は上面と同じく若い id が1回だけ持つ。
 *
 * 壁との接触は考慮しない（旧 beamExposedAreaM2 の wallIndex による面数ハードコードは廃止）。
 * 壁梁の裏面や壁クロスとの二重計上は呼び出し側で処理すること。
 * 寸法が非有限・非正の梁は 0（Map には 0 で入る）。
 */
export function beamExposedAreaByIdM2(
  solids: BeamSolid[],
  roomHeightMm: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!solids || solids.length === 0) return out;
  // 無効な梁も呼び出し側が id で引けるよう 0 で埋める。
  for (const s of solids) {
    if (s && typeof s.id === 'string') out.set(s.id, 0);
  }

  const items = prepare(solids);
  if (items.length === 0) return out;
  const ceilingKnown = Number.isFinite(roomHeightMm);

  for (let i = 0; i < items.length; i++) {
    const self = items[i];
    const height = self.top - self.bottom;
    let mm2 = 0;

    // ---- 上面 ----
    // 天井高が不明なときは天井接触を判定できないので露出扱い（beamArea.ts の下面と同じ安全側）。
    if (!ceilingKnown || self.top < roomHeightMm - EPS_MM) {
      const occ: Pt[][] = [];
      for (let j = 0; j < items.length; j++) {
        if (j === i) continue;
        const other = items[j];
        if (coversJustAbove(other, self.top)) occ.push(other.poly);
        else if (Math.abs(other.top - self.top) <= EPS_MM && !hasPriority(self, other))
          occ.push(other.poly); // 同一高さの上面は若い id が1回だけ持つ
      }
      mm2 += areaOfPolyMinusUnion(self.poly, occ);
    }

    // ---- 下面 ----
    if (self.bottom > EPS_MM) {
      const occ: Pt[][] = [];
      for (let j = 0; j < items.length; j++) {
        if (j === i) continue;
        const other = items[j];
        if (coversJustBelow(other, self.bottom)) occ.push(other.poly);
        else if (Math.abs(other.bottom - self.bottom) <= EPS_MM && !hasPriority(self, other))
          occ.push(other.poly);
      }
      mm2 += areaOfPolyMinusUnion(self.poly, occ);
    }

    // ---- 側面（footprint の全辺）----
    // 鉛直帯は室内（[0, 天井高]）へクランプする。床下・天井裏へはみ出した梁の側面は見えないので
    // 計上しない（上下面は接触判定で既に抑止されているのに側面だけ素通りしていた・260728 敵対検証）。
    const sideBottom = Math.max(self.bottom, 0);
    const sideTop = ceilingKnown ? Math.min(self.top, roomHeightMm) : self.top;
    const sideHeight = Math.max(0, sideTop - sideBottom);
    for (let e = 0; e < self.poly.length && sideHeight > 0; e++) {
      const a = self.poly[e];
      const b = self.poly[(e + 1) % self.poly.length];
      const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(edgeLen > 0)) continue;
      const others: BeamSolid[] = [];
      for (let j = 0; j < items.length; j++) {
        if (j === i) continue;
        const other = items[j];
        // 同一平面・同一向きの面は1枚しかない。自分が持つ番なら相手を遮蔽物から外す。
        // （凸なので other が この辺の直線と接するのはその同一面だけ＝他の遮蔽を取りこぼさない）
        if (hasCoplanarSameNormalEdge(a, b, other.poly) && hasPriority(self, other)) continue;
        others.push(other.solid);
      }
      const faceMm2 = edgeLen * sideHeight;
      const occluded = occludedSideAreaMm2(a, b, sideBottom, sideTop, others);
      mm2 += Math.max(0, faceMm2 - occluded);
    }

    out.set(self.id, (out.get(self.id) ?? 0) + mm2 / 1e6);
  }
  return out;
}

/**
 * Beam[]（プロジェクト状態）→ BeamSolid[]（このモジュールの入力）への変換。
 * footprint は既存の beamFootprintCornersMm（回転矩形の四隅）をそのまま使う。
 * 鉛直帯は top = roomHeightMm − dropMm、bottom = top − heightMm。
 */
export function beamSolidsFromBeams(
  beams: Array<
    Pick<Beam, 'id' | 'cx' | 'cy' | 'lengthMm' | 'angleDeg' | 'widthMm' | 'heightMm'> & {
      dropMm?: number;
    }
  >,
  roomHeightMm: number,
): BeamSolid[] {
  const out: BeamSolid[] = [];
  if (!beams || beams.length === 0) return out;
  for (const beam of beams) {
    if (!beam) continue;
    const drop = Number.isFinite(beam.dropMm) ? (beam.dropMm as number) : 0;
    const h = Number.isFinite(beam.heightMm) ? beam.heightMm : 0;
    const top = roomHeightMm - drop;
    out.push({
      id: beam.id,
      poly: beamFootprintCornersMm(beam),
      bottomMm: top - h,
      topMm: top,
    });
  }
  return out;
}

/** 壁スラブ（非課金の遮蔽体）の id 接頭辞。結果マップから読み出すときは除外すること。 */
export const WALL_OCCLUDER_ID_PREFIX = '__wall:';

/** 合成された遮蔽体（実在の梁ではない）か。 */
export function isWallOccluderId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(WALL_OCCLUDER_ID_PREFIX);
}

/**
 * 部屋の壁を「非課金の遮蔽体」として BeamSolid 化する（260728 #10 の配線用）。
 *
 * なぜ必要か: beamExposedAreaByIdM2 は梁を立体として扱い、側面4枚すべてを露出候補として返す。
 * 旧実装は壁梁を wallIndex で見分けて「側面1枚・端面0枚」とハードコードしていたが、これは
 * 「壁に接する面は見えない」という物理を場合分けで近似したものにすぎない。壁そのものを遮蔽体として
 * 渡せば、壁梁の背面も、壁に突き当たる端面も、壁沿いに置いただけの自由梁の背面も、すべて同じ規則で
 * 自動的に除外される（場合分けが消え、取りこぼしも無くなる）。
 *
 * 形状: 各壁セグメントの外側に厚さ thicknessMm のスラブを置く。室内側の面はちょうど壁線上に来るので、
 * 壁にぴったり接する梁面（＝境界が一致）は occludedSideAreaMm2 の境界含む判定で確実に埋まる。
 * スラブは室外にあるため、梁の上下面（footprint 同士の交差）には一切影響しない。
 * 角の隙間を塞ぐため、壁方向へ thicknessMm だけ両端を延長する。
 *
 * @param pointsMm 部屋ポリゴンの頂点（mm・sketchPoints を /0.05 したもの）
 */
export function roomWallOccluders(
  pointsMm: Pt[],
  roomHeightMm: number,
  thicknessMm = 200,
): BeamSolid[] {
  const out: BeamSolid[] = [];
  if (!pointsMm || pointsMm.length < 3) return out;
  if (!Number.isFinite(roomHeightMm) || !(roomHeightMm > 0)) return out;
  // ポリゴンの向き（CCW/CW）から「室内側」を決める。符号付き面積が正なら CCW。
  let signed = 0;
  for (let i = 0; i < pointsMm.length; i++) {
    const p = pointsMm[i];
    const q = pointsMm[(i + 1) % pointsMm.length];
    signed += p.x * q.y - q.x * p.y;
  }
  const ccw = signed > 0;
  const t = Math.max(1, thicknessMm);

  for (let i = 0; i < pointsMm.length; i++) {
    const p1 = pointsMm[i];
    const p2 = pointsMm[(i + 1) % pointsMm.length];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    const ux = dx / len;
    const uy = dy / len;
    // CCW ポリゴンでは左法線(-uy, ux)が室内側。CW なら反転。外向き＝室内の逆。
    const inx = ccw ? -uy : uy;
    const iny = ccw ? ux : -ux;
    const outx = -inx;
    const outy = -iny;
    // 壁線上の辺（内側）と、そこから外へ t だけ出た辺（外側）。両端を t だけ延長して角を塞ぐ。
    const a = { x: p1.x - ux * t, y: p1.y - uy * t };
    const b = { x: p2.x + ux * t, y: p2.y + uy * t };
    out.push({
      id: `${WALL_OCCLUDER_ID_PREFIX}${i}`,
      poly: [
        { x: a.x, y: a.y },
        { x: b.x, y: b.y },
        { x: b.x + outx * t, y: b.y + outy * t },
        { x: a.x + outx * t, y: a.y + outy * t },
      ],
      bottomMm: 0,
      topMm: roomHeightMm,
    });
  }
  return out;
}
