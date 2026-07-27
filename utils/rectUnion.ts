// 軸並行矩形群の「和集合」面積を厳密に求める（260728 クライアント要望 #10/#11）。
//
// これまで見積の面積計算は「重なり分＝ペア交差面積の総和」を引いていた（包除原理の2項打ち切り）。
// これは重なりが2枚までなら正しいが、3枚以上が同じ領域に重なると引きすぎる。
// 例：同じ 2×2 の領域を3枚が覆う場合、正解は 4 なのに 4×3 − 4×3 = 0 になってしまう。
// （包除原理は +Σ三重交差 … と交互に続く級数であり、途中で打ち切ると符号が偏るため。）
//
// そこで「重なりを引く」のをやめ、最初から和集合面積そのものを求める方式に切り替える。
// 用途は
//   ・壁面積 − (開口 ∪ 梁の帯)              … 開口と梁が同じ場所で重なっても正しい
//   ・梁の露出面 − (他の梁の footprint の和)  … 3本以上が交差しても正しい
// のように「A から B 群の和を引く」形。ここでは B 群の和集合面積だけを担当する（純関数・leaf）。
//
// アルゴリズムは x 座標によるスラブ分割スイープ：
//   1. 全矩形の x0/x1 を集めて一意化・昇順ソート → 隣接ペアが「スラブ（縦の帯）」になる
//   2. 各スラブを完全に跨ぐ矩形の y 区間を集めてマージ（重複を潰す）
//   3. マージ後の長さ合計 × スラブ幅 を加算
// スラブ境界は必ず矩形の辺なので、矩形はスラブを「完全に跨ぐ」か「全く重ならない」かの二択になり、
// 中点サンプリング等の近似を挟まずに厳密値が出る。
// 計算量は O(n² log n) だが、n は1つの壁の開口＋梁の本数（せいぜい数十）なので問題ない。

/** 軸並行矩形。単位は呼び出し側に依存（mm でも m でも可）。x0<x1 / y0<y1 は内部で正規化する。 */
export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * 矩形を正規化する。反転（x0>x1 / y0>y1）は入れ替え、
 * 非有限値（NaN/Infinity）や面積0以下のものは null にして無視させる。
 * ＝ 上流のデータ欠損（未入力の開口など）が面積を NaN 汚染するのを防ぐため。
 */
function normalizeRect(r: Rect): Rect | null {
  if (!r) return null;
  const { x0, x1, y0, y1 } = r;
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
  const nx0 = Math.min(x0, x1);
  const nx1 = Math.max(x0, x1);
  const ny0 = Math.min(y0, y1);
  const ny1 = Math.max(y0, y1);
  // 幅または高さが0以下（＝面積に寄与しない）矩形は捨てる。
  if (!(nx1 > nx0) || !(ny1 > ny0)) return null;
  return { x0: nx0, x1: nx1, y0: ny0, y1: ny1 };
}

/**
 * 1次元区間の和集合をマージする（スイープの内側で使う。テスト用に export）。
 * ・入力順は問わない（内部で開始位置ソート）
 * ・接している区間（[0,1] と [1,2]）も1本に結合する ＝ 面積として連続だから
 * ・反転区間は入れ替え、非有限値は無視、長さ0の区間は面積に寄与しないので落とす
 * 返り値は開始位置昇順・互いに交わらない区間列。
 */
export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const cleaned: Array<[number, number]> = [];
  for (const iv of intervals) {
    if (!iv) continue;
    const a = iv[0];
    const b = iv[1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (!(hi > lo)) continue;
    cleaned.push([lo, hi]);
  }
  if (cleaned.length === 0) return [];
  cleaned.sort((p, q) => p[0] - q[0]);

  const merged: Array<[number, number]> = [];
  let [curLo, curHi] = cleaned[0];
  for (let i = 1; i < cleaned.length; i++) {
    const [lo, hi] = cleaned[i];
    if (lo <= curHi) {
      // 重なり or 隣接 → 伸ばす（内包 [1,2]⊂[0,5] のケースがあるので max を取る）
      if (hi > curHi) curHi = hi;
    } else {
      merged.push([curLo, curHi]);
      curLo = lo;
      curHi = hi;
    }
  }
  merged.push([curLo, curHi]);
  return merged;
}

/**
 * 軸並行矩形群の和集合面積（厳密値）。重なりは何枚重なっても1回だけ数える。
 * 単位は入力の単位の2乗（mm を渡せば mm²、m を渡せば m²）。
 * 空配列・全て無効な入力は 0。
 */
export function unionAreaOfRects(rects: Rect[]): number {
  if (!rects || rects.length === 0) return 0;
  const norm: Rect[] = [];
  for (const r of rects) {
    const n = normalizeRect(r);
    if (n) norm.push(n);
  }
  if (norm.length === 0) return 0;

  // スラブ境界＝全矩形の x 辺。一意化してソート。
  const xsSet = new Set<number>();
  for (const r of norm) {
    xsSet.add(r.x0);
    xsSet.add(r.x1);
  }
  const xs = Array.from(xsSet).sort((a, b) => a - b);

  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i];
    const xb = xs[i + 1];
    const width = xb - xa;
    if (!(width > 0)) continue;

    // スラブを完全に跨ぐ矩形だけを集める。境界が矩形の辺と一致しているため
    // 「跨ぐ or 無関係」の二択になり、中点サンプリングのような誤差要因が入らない。
    const spans: Array<[number, number]> = [];
    for (const r of norm) {
      if (r.x0 <= xa && r.x1 >= xb) spans.push([r.y0, r.y1]);
    }
    if (spans.length === 0) continue;

    let covered = 0;
    for (const [lo, hi] of mergeIntervals(spans)) covered += hi - lo;
    total += covered * width;
  }
  return total;
}
