// 壁セグメント（矩形）から開口（窓/ドア）を差し引いた「実体の矩形群」を求める純関数（260703）。
//
// 背景: 腰壁（壁の上下2分割）で窓・ドアがある壁の穴あけがうまく出なかった。従来は THREE.Shape を
// 「1枚の外周矩形＋穴（holes）」で表現していたが、開口がセグメントの全高をまたぐ（上下端の両方に接する）と、
// 壁は「左右2本の柱」に分断される。単一 THREE.Shape は非連結領域を表現できないため、境界に極薄の帯を残して
// 連結を保っていた＝分割線に継ぎ目（横線）が出る/三角形分割が破綻する原因だった。
//
// 対策: セグメント矩形から開口矩形を引いた結果を「複数の実体矩形（タイル）」として構築する。
// THREE.ShapeGeometry は Shape の配列を受け付けるため、分断された柱も欠けなく描け、穴が外周に接する
// 退化ポリゴンも生じない。UV は各頂点のローカル座標(m)＝面積非依存の実寸タイリングがそのまま保たれる。

/** セグメントのローカル座標系（中心原点）における矩形。x/y は [min,max]。 */
export interface LocalRect {
  xL: number;
  xR: number;
  yB: number;
  yT: number;
}

const EPS = 1e-6;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * セグメント矩形 [-halfW,halfW] x [-halfH,halfH] から開口群を差し引いた実体矩形の配列を返す。
 * openings はセグメントのローカル座標（中心原点・m）で与える。セグメント外へはみ出す開口はクランプする。
 *
 * アルゴリズム（X スラブ掃引）:
 *  1. セグメント左右端＋各開口の xL/xR を境界として X 軸を区間に分割する。
 *  2. 各 X 区間について、その区間を完全に覆う開口の Y レンジを統合（マージ）する。
 *     （境界が開口端なので、各開口は区間を「完全に覆う」か「全く重ならない」かのどちらか。）
 *  3. セグメントの Y レンジ [-halfH,halfH] から統合済み開口 Y レンジを引いた残り（実体）を矩形として出力。
 *
 * 開口が全高を覆う区間は実体 Y レンジが空になり矩形を出さない（＝完全に開く＝柱に分断）。
 * 同一材質のセグメント内なので隣接タイルの T 字接合（極細ヒビ）は視認上問題にならない。
 */
export function solidRectsForSegment(halfW: number, halfH: number, openings: LocalRect[]): LocalRect[] {
  if (!(halfW > EPS) || !(halfH > EPS)) return [];

  // 有効な開口のみ（セグメント幅にクランプして幅・高さが残るもの）。
  const ops = openings
    .map((o) => ({
      xL: clamp(Math.min(o.xL, o.xR), -halfW, halfW),
      xR: clamp(Math.max(o.xL, o.xR), -halfW, halfW),
      yB: clamp(Math.min(o.yB, o.yT), -halfH, halfH),
      yT: clamp(Math.max(o.yB, o.yT), -halfH, halfH),
    }))
    .filter((o) => o.xR - o.xL > EPS && o.yT - o.yB > EPS);

  if (ops.length === 0) {
    return [{ xL: -halfW, xR: halfW, yB: -halfH, yT: halfH }];
  }

  // X 境界（重複除去・昇順）。
  const xsSet = new Set<number>([-halfW, halfW]);
  for (const o of ops) {
    xsSet.add(o.xL);
    xsSet.add(o.xR);
  }
  const xs = [...xsSet].sort((a, b) => a - b);

  const out: LocalRect[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    if (x1 - x0 <= EPS) continue;
    const xc = (x0 + x1) / 2;

    // この X 区間を覆う開口の Y レンジ。
    const yRanges = ops
      .filter((o) => o.xL <= xc && o.xR >= xc)
      .map((o) => [o.yB, o.yT] as [number, number])
      .sort((a, b) => a[0] - b[0]);

    // 重なる Y レンジをマージ。
    const merged: [number, number][] = [];
    for (const [a, b] of yRanges) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + EPS) {
        last[1] = Math.max(last[1], b);
      } else {
        merged.push([a, b]);
      }
    }

    // セグメント [-halfH,halfH] から開口 Y レンジを引いた実体レンジを矩形化。
    let cursor = -halfH;
    for (const [a, b] of merged) {
      if (a - cursor > EPS) out.push({ xL: x0, xR: x1, yB: cursor, yT: a });
      cursor = Math.max(cursor, b);
    }
    if (halfH - cursor > EPS) out.push({ xL: x0, xR: x1, yB: cursor, yT: halfH });
  }
  return out;
}
