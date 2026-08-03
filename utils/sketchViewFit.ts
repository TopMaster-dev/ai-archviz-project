import type { Point } from '../types.js';

/**
 * 2Dビューの「図面全体を画面中央に収める」計算（260806 クライアント要望④）。
 *
 * 【なぜ必要か】
 * 2Dビューは初期表示が固定（ズーム 0.08・原点まわり）だった。図面を原点から離れた座標に
 * 描いていると、3Dから2Dへ切り替えたときに図面が画面外へ出てしまい、真っ暗な画面が出る
 * （利用者が「全体」を押すまで図面が見えない）。
 * 表示のたびに中身の外接矩形へ合わせ直せば、どこに描いてあっても必ず図面が見える。
 *
 * 【ここに置く理由】
 * ズーム・オフセットは SketchCanvas の ref（再描画を避けるため）で、コンポーネント内では
 * 検証しづらい。外接矩形と、そこから決まるズーム・オフセットは純粋な計算なので分離して
 * テストできるようにする。
 */

export interface BoundsMm {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 有限な数値だけを通す（NaN が1つ混ざると外接矩形全体が NaN になり、視点が飛ぶ）。 */
const finite = (v: number) => Number.isFinite(v);

/** 点群の外接矩形。点が無い・すべて壊れている場合は null（＝「中身なし」を呼び出し側で判別できる）。 */
export function boundsFromPoints(points: readonly Point[] | null | undefined): BoundsMm | null {
  if (!points || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!p || !finite(p.x) || !finite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!finite(minX) || !finite(minY) || !finite(maxX) || !finite(maxY)) return null;
  return { minX, minY, maxX, maxY };
}

/** 矩形（左上・右下）から外接矩形。順序が逆でも受ける。 */
export function boundsFromRect(x0: number, y0: number, x1: number, y1: number): BoundsMm | null {
  if (!finite(x0) || !finite(y0) || !finite(x1) || !finite(y1)) return null;
  return {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1),
  };
}

/**
 * 回転した矩形（梁など）の外接矩形。
 * 中心まわりに角度 θ で長さ L・幅 W の矩形を置いたときの軸平行半径は
 *   hx = |cosθ|·L/2 + |sinθ|·W/2 ／ hy = |sinθ|·L/2 + |cosθ|·W/2。
 * 角度の基準が違っても L と W が入れ替わるだけで、外接矩形は図形を必ず含む（＝収まらない事故は起きない）。
 */
export function boundsFromRotatedRect(
  cx: number,
  cy: number,
  lengthMm: number,
  widthMm: number,
  angleDeg: number,
): BoundsMm | null {
  if (!finite(cx) || !finite(cy) || !finite(lengthMm) || !finite(widthMm) || !finite(angleDeg)) return null;
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const halfL = Math.abs(lengthMm) / 2;
  const halfW = Math.abs(widthMm) / 2;
  const hx = c * halfL + s * halfW;
  const hy = s * halfL + c * halfW;
  return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
}

/** 外接矩形の合成。片方が null（中身なし）ならもう片方をそのまま返す。 */
export function unionBounds(a: BoundsMm | null, b: BoundsMm | null): BoundsMm | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** 複数の外接矩形をまとめる。 */
export function unionAllBounds(list: readonly (BoundsMm | null)[]): BoundsMm | null {
  return list.reduce<BoundsMm | null>((acc, b) => unionBounds(acc, b), null);
}

export interface FitViewOptions {
  /** 図面の外側に取る余白（mm）。 */
  paddingMm: number;
  /** これ以上は拡大しない（小さい図面で過剰に寄らないための上限）。 */
  maxZoom: number;
  /** これ以上は縮小しない（巨大な下絵などでズームが 0 に潰れないための下限）。 */
  minZoom: number;
}

export interface FitView {
  zoom: number;
  offset: Point;
}

/**
 * 外接矩形が画面いっぱいに収まり、かつ中心に来るズームとオフセットを返す。
 * 画面座標 = 世界mm × zoom + offset なので、
 * 図面中心を画面中心へ持ってくる offset は canvas/2 − center × zoom。
 *
 * 計算できないとき（中身なし・キャンバス未実測・値が壊れている）は null を返す。
 * 呼び出し側は視点を変えないこと（既定値へ勝手に飛ばすと、描いている最中に視点が跳ねる）。
 */
export function computeFitView(
  bounds: BoundsMm | null,
  canvasWidth: number,
  canvasHeight: number,
  { paddingMm, maxZoom, minZoom }: FitViewOptions,
): FitView | null {
  if (!bounds) return null;
  if (!finite(canvasWidth) || !finite(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) return null;
  const { minX, minY, maxX, maxY } = bounds;
  if (!finite(minX) || !finite(minY) || !finite(maxX) || !finite(maxY)) return null;

  // 幅・高さが 0（点1つ・線1本）でも余白があるので 0 除算にはならない。
  const pad = finite(paddingMm) && paddingMm > 0 ? paddingMm : 0;
  const width = maxX - minX + pad * 2;
  const height = maxY - minY + pad * 2;
  if (!(width > 0) || !(height > 0)) return null;

  const rawZoom = Math.min(canvasWidth / width, canvasHeight / height, maxZoom);
  const zoom = Math.max(minZoom, rawZoom);
  if (!finite(zoom) || zoom <= 0) return null;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const offset = {
    x: canvasWidth / 2 - centerX * zoom,
    y: canvasHeight / 2 - centerY * zoom,
  };
  if (!finite(offset.x) || !finite(offset.y)) return null;
  return { zoom, offset };
}

/**
 * ズームアウトの下限（これ以上は縮小させない）。
 *
 * 全体表示と「必ず同じ外接矩形」から求めること。作図点だけから求めていたときは、
 * 中身が作図点より大きい場合（大きな下絵・部屋の外へ出した家具や自由梁）に
 * 「全体表示のズーム ＜ 縮小の下限」となり、全体表示の直後に「−」を押すと逆に拡大した。
 *
 * @param relativeToFit 全体が収まるズームに対する比率（小さいほど引ける）
 */
export function computeMinZoom(
  bounds: BoundsMm | null,
  canvasWidth: number,
  canvasHeight: number,
  { paddingMm, maxZoom, minZoom }: FitViewOptions,
  relativeToFit: number,
): number {
  const fit = computeFitView(bounds, canvasWidth, canvasHeight, { paddingMm, maxZoom, minZoom });
  if (!fit) return minZoom;
  const floor = fit.zoom * relativeToFit;
  if (!finite(floor) || floor <= 0) return minZoom;
  // 全体表示のズームを上回らせない。上回ると「全体」の直後に縮小できなくなる。
  return Math.min(fit.zoom, Math.max(minZoom, floor));
}
