import type { NormalizedRect } from '../types.js';

/**
 * エリア編集 case B（260718 監査対応）で使う、検出した開口（窓・ドア）矩形の後処理ヘルパー。
 *
 * 背景: 面仕上げ（壁の緑化・塗装・タイル等）で「面全体を一様に塗り、検出した窓・ドアだけを合成で除外（＝元のまま保持）」
 * する。除外はモデルが返した開口の外接矩形を destination-out でマスクから穴あけして行う。ところが最終の union 合成では
 * すべての範囲（placement）を1枚のマスクに束ね、そこへ全範囲ぶんの開口をまとめて穴あけしていた。すると面Aの窓の外接矩形が
 * 隣接する面Bの範囲へはみ出していると、Bの仕上げにも穴が空き、Bの“元の壁”が露出してしまう（隣の壁に塗り残しが出る不具合）。
 *
 * 本ヘルパーは各面の開口を、その面自身の placements の外接矩形へクリップして、他の面へはみ出さないようにする。
 * 交差が無い（完全にはみ出した）開口は落とす。返す矩形は {x,y,width,height}（points は落として単純な矩形として扱う）。
 * 純関数（DOM 非依存）なのでユニットテスト可能。
 */

/** placements（矩形/多角形）全体の外接矩形（正規化 AABB）。頂点があれば頂点で、無ければ矩形で包む。空なら null。 */
export function placementsBBox(
  placements: NormalizedRect[]
): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of placements) {
    if (p.points && p.points.length >= 3) {
      for (const pt of p.points) {
        x0 = Math.min(x0, pt.x);
        y0 = Math.min(y0, pt.y);
        x1 = Math.max(x1, pt.x);
        y1 = Math.max(y1, pt.y);
      }
    } else {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.width);
      y1 = Math.max(y1, p.y + p.height);
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/** 多角形の面積（シューレース公式・絶対値）。 */
function polygonArea(pts: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** placements の合計面積（正規化・多角形はシューレース、矩形は w*h）。0以上。 */
export function placementsArea(placements: NormalizedRect[]): number {
  let area = 0;
  for (const p of placements) {
    if (p.points && p.points.length >= 3) {
      area += polygonArea(p.points);
    } else {
      area += Math.max(0, p.width) * Math.max(0, p.height);
    }
  }
  return area;
}

/**
 * 誤検出の決定論バックストップ（260718 監査 R2-1）。モデルが窓・ドアを誤検出すると、その矩形を面から穴あけして
 * 「元の壁が露出した塗り残し」を作ってしまう。開口の合計面積が、囲った面（placements）の面積に対して maxCoverageFrac を
 * 超える＝「面のほとんどが開口」という非現実的な検出は、丸ごと誤検出とみなして開口を全部落とす（＝穴を空けず、AI の
 * 一様塗り＋ソフト保持に委ねる）。これで最悪ケース（面全体が未仕上げになる）を確実に防ぐ。中程度の誤検出までは防げない
 * ため、プロンプト精度（低温＋除外リスト＋「疑わしきは挙げない」）と併用する。placements が退化なら素通し。
 */
export function dropImplausibleOpenings(
  openings: NormalizedRect[],
  placements: NormalizedRect[],
  maxCoverageFrac = 0.7
): NormalizedRect[] {
  const pArea = placementsArea(placements);
  if (pArea <= 0) return openings;
  const oArea = openings.reduce((s, o) => s + Math.max(0, o.width) * Math.max(0, o.height), 0);
  if (oArea / pArea > maxCoverageFrac) return [];
  return openings;
}

/**
 * 開口矩形群を placements の外接矩形へクリップする。はみ出した部分は切り取り、交差の無いものは落とす。
 * placements が空/退化なら空配列（穴あけ対象なし）。極小（面積ほぼゼロ）になった開口も落とす。
 */
export function clipOpeningsToPlacements(
  openings: NormalizedRect[],
  placements: NormalizedRect[]
): NormalizedRect[] {
  const bb = placementsBBox(placements);
  if (!bb) return [];
  const out: NormalizedRect[] = [];
  for (const o of openings) {
    const ox0 = o.x;
    const oy0 = o.y;
    const ox1 = o.x + o.width;
    const oy1 = o.y + o.height;
    const nx0 = Math.max(ox0, bb.x0);
    const ny0 = Math.max(oy0, bb.y0);
    const nx1 = Math.min(ox1, bb.x1);
    const ny1 = Math.min(oy1, bb.y1);
    // 除外は面から穴を空ける操作なので、極小の断片は無視（塗り残しの点々を作らない）。
    if (nx1 - nx0 <= 0.002 || ny1 - ny0 <= 0.002) continue;
    // クリップ不要（元々この面の外接矩形に完全に収まる＝典型ケース）なら、元の値をそのまま採用する。
    // Math.max/Math.min の再計算による浮動小数の微小誤差（0.3-0.1≠0.2 等）を避け、決定論的に元矩形を保つ。
    if (nx0 === ox0 && ny0 === oy0 && nx1 === ox1 && ny1 === oy1) {
      out.push({ x: o.x, y: o.y, width: o.width, height: o.height });
    } else {
      out.push({ x: nx0, y: ny0, width: nx1 - nx0, height: ny1 - ny0 });
    }
  }
  return out;
}
