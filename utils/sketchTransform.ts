import { FurnitureItem, Opening, Point } from '../types.js';

export const SKETCH_BASE_SCALE = 0.05;
export const MM_PER_METER = 1000;
export const DOOR_FRAME_THICKNESS_MM = 40;

export const getEffectiveOpeningWidthMm = (opening: Pick<Opening, 'type' | 'width'>): number =>
  opening.type.startsWith('door')
    ? opening.width + DOOR_FRAME_THICKNESS_MM * 2
    : opening.width;

export interface RoomTransformResult {
  centerScaled: Point;
  centerMm: Point;
  mPoints: { x: number; z: number }[];
  isCCW: boolean;
}

export const scaledToMm = (value: number) => value / SKETCH_BASE_SCALE;
export const mmToScaled = (value: number) => value * SKETCH_BASE_SCALE;

export const lerpPoint = (p1: Point, p2: Point, t: number): Point => ({
  x: p1.x + (p2.x - p1.x) * t,
  y: p1.y + (p2.y - p1.y) * t
});

export const getWallSegment = (points: Point[], wallIndex: number) => {
  if (points.length < 2 || wallIndex < 0 || wallIndex >= points.length) return null;
  const p1 = points[wallIndex];
  const p2 = points[(wallIndex + 1) % points.length];
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return null;
  return { p1, p2, dx, dy, length };
};

export const getWallLengthMm = (points: Point[], wallIndex: number): number | null => {
  const seg = getWallSegment(points, wallIndex);
  if (!seg) return null;
  return scaledToMm(seg.length);
};

/** 2直線 (a0 + t·aDir) と (b0 + s·bDir) の交点。平行/縮退/非有限時は null。 */
export const intersectLines2D = (a0: Point, aDir: Point, b0: Point, bDir: Point): Point | null => {
  const denom = aDir.x * bDir.y - aDir.y * bDir.x;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) return null;
  const t = ((b0.x - a0.x) * bDir.y - (b0.y - a0.y) * bDir.x) / denom;
  const p = { x: a0.x + t * aDir.x, y: a0.y + t * aDir.y };
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return p;
};

/**
 * エッジ p1->p2 の、室内側（ポリゴン内部側）を向く単位法線。
 * 「辺の中点から法線方向へ微小に進めた点がポリゴン内部か」を pointInPolygon で各辺ローカルに判定する。
 * 面積重心との内積で判定する方式は、凹多角形（L字・階段欠き込み等）で重心がポリゴン外に出ると
 * 一部の辺で内外が反転するため採用しない（重心非依存・凹形状でも各辺で正しく内側を向く）。
 */
const inwardUnitNormal = (p1: Point, p2: Point, polygon: Point[]): Point => {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  // 辺中点から法線方向へごく僅か（辺長の0.1%、最小0.01mm）進めた点が内部なら内側。なければ反転。
  const eps = Math.max(len * 0.001, 0.01);
  if (!pointInPolygon({ x: mx + nx * eps, y: my + ny * eps }, polygon)) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
};

/** 閉ポリゴン（mm）の面積重心。3頂点未満／縮退時は null。2D/3D の壁梁マイターで共有。 */
export const polygonCentroidMm = (points: Point[]): Point | null => {
  if (points.length < 3) return null;
  let twiceA = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const cross = points[i].x * points[j].y - points[j].x * points[i].y;
    twiceA += cross;
    cx += (points[i].x + points[j].x) * cross;
    cy += (points[i].y + points[j].y) * cross;
  }
  if (Math.abs(twiceA) < 1e-9) return null;
  return { x: cx / (3 * twiceA), y: cy / (3 * twiceA) };
};

export interface BeamBandCorners {
  /** c1=壁p1(外側), c2=壁p2(外側), c3=p2内側(マイター), c4=p1内側(マイター) */
  c1: Point;
  c2: Point;
  c3: Point;
  c4: Point;
}

/**
 * 壁梁の室内側バンドの四隅(mm)を、隣接する壁梁とマイター接合して返す（260611 #2b）。
 * 入隅では隙間、出角では重なりが生じる「直角キャップ」を、隣接エッジの内側オフセット線との
 * 交点で接合して解消する。隣接エッジに壁梁が無い／交点が求まらない場合は直角キャップにフォールバック。
 *
 * 内側方向は points から各辺ローカルに判定するため、凹多角形でも正しく室内側にバンドを置く。
 *
 * @param points     スケッチ頂点（mm, 閉ポリゴン）
 * @param widthByWallIndex 壁梁が乗っているエッジ index → そのバンド幅(mm)
 * @param wallIndex  対象の壁梁のエッジ index
 */
export const getWallBeamBandCornersMm = (
  points: Point[],
  widthByWallIndex: Map<number, number>,
  wallIndex: number,
): BeamBandCorners | null => {
  const n = points.length;
  if (n < 2) return null;
  const seg = getWallSegment(points, wallIndex);
  if (!seg) return null;
  const width = widthByWallIndex.get(wallIndex) ?? 0;
  const nThis = inwardUnitNormal(seg.p1, seg.p2, points);
  const dirThis = { x: seg.dx, y: seg.dy };
  // このエッジの内側オフセット線上の通過点（p1側・p2側）
  const inA: Point = { x: seg.p1.x + nThis.x * width, y: seg.p1.y + nThis.y * width };
  const inB: Point = { x: seg.p2.x + nThis.x * width, y: seg.p2.y + nThis.y * width };

  let c4: Point = inA; // p1内側（既定=直角キャップ）
  let c3: Point = inB; // p2内側（既定=直角キャップ）

  // 開始頂点 point[wallIndex] を共有する前エッジ (wallIndex-1) とマイター。
  // 隣に壁梁があればその内側オフセット線、無ければ壁芯線(オフセット0)と接合する。
  // → 隣に梁が無い角でも、梁端が隣の壁面に沿って切られ、突き出し/隙間が出ない（2D/3D共通）。
  const prevIdx = (wallIndex - 1 + n) % n;
  if (prevIdx !== wallIndex) {
    const prev = getWallSegment(points, prevIdx);
    if (prev) {
      const nPrev = inwardUnitNormal(prev.p1, prev.p2, points);
      const wPrev = widthByWallIndex.get(prevIdx) ?? 0;
      const prevInner: Point = { x: prev.p1.x + nPrev.x * wPrev, y: prev.p1.y + nPrev.y * wPrev };
      const m = intersectLines2D(inA, dirThis, prevInner, { x: prev.dx, y: prev.dy });
      if (m) c4 = m;
    }
  }
  // 終了頂点 point[(wallIndex+1)%n] を共有する次エッジ (wallIndex+1) とマイター（前エッジと同様）。
  const nextIdx = (wallIndex + 1) % n;
  if (nextIdx !== wallIndex) {
    const next = getWallSegment(points, nextIdx);
    if (next) {
      const nNext = inwardUnitNormal(next.p1, next.p2, points);
      const wNext = widthByWallIndex.get(nextIdx) ?? 0;
      const nextInner: Point = { x: next.p1.x + nNext.x * wNext, y: next.p1.y + nNext.y * wNext };
      const m = intersectLines2D(inB, dirThis, nextInner, { x: next.dx, y: next.dy });
      if (m) c3 = m;
    }
  }
  return { c1: seg.p1, c2: seg.p2, c3, c4 };
};

export const getWallAngle2D = (p1: Point, p2: Point) => Math.atan2(p2.y - p1.y, p2.x - p1.x);

export const getWallRotationY = (p1: { x: number; z: number }, p2: { x: number; z: number }, isCCW: boolean) => {
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  let rotationY = Math.atan2(-dz, dx);
  if (isCCW) rotationY += Math.PI;
  return rotationY;
};

// RoomViewer では isCCW 時に壁groupへ PI を加算しており、ローカルX軸が反転する。
// その反転を建具配置/ドラッグで吸収するための共通マッピング。
export const openingRatioToWallLocalX = (ratioPosition: number, wallLength: number, isAxisFlipped: boolean) => {
  const normalized = isAxisFlipped ? 1 - ratioPosition : ratioPosition;
  return (normalized - 0.5) * wallLength;
};

export const wallLocalXToOpeningRatio = (localX: number, wallLength: number, isAxisFlipped: boolean) => {
  const normalized = (localX + wallLength / 2) / wallLength;
  return isAxisFlipped ? 1 - normalized : normalized;
};

export const clampOpeningRatioWithCollisions = (
  targetRatio: number,
  wallLength: number,
  selfWidthMm: number,
  selfRatio: number,
  otherOpenings: Array<{ ratioPosition: number; width: number }>
) => {
  const selfHalf = selfWidthMm / 2;
  let minX = selfHalf;
  let maxX = wallLength - selfHalf;
  const currentPos = selfRatio * wallLength;
  otherOpenings.forEach((other) => {
    const otherPos = other.ratioPosition * wallLength;
    const otherHalf = other.width / 2;
    if (otherPos < currentPos) minX = Math.max(minX, otherPos + otherHalf + selfHalf);
    else maxX = Math.min(maxX, otherPos - otherHalf - selfHalf);
  });
  const wallPos = targetRatio * wallLength;
  const clampedX = Math.max(minX, Math.min(maxX, wallPos));
  return clampedX / wallLength;
};

/**
 * 3Dドアの吊り元(hinge)と開き方向(open)の符号を、2D平面図と同じ規約で返す（260611 Sec1）。
 * 既定（フラグ無し）は「室内側へ開く・p1側が吊り元」。
 *  - swingFlipX: 吊り元の左右を反転（2Dの sx と一致）。
 *  - swingFlipY: 開く内外を反転（2Dの sy と一致）。
 *  - isLocalPlusZIndoor: 壁ローカル +Z が室内側か（2Dの「室内側へ開く」アンカーと対応）。
 *  - isAxisFlipped: 壁ローカルXが反転しているか（isCCW。建具配置 openingRatioToWallLocalX と同じ補正）。
 * @returns hingeXSign 吊り元のローカルX符号(±1) / openZSign 開く先のローカルZ符号(±1)
 */
export const resolveDoorSwing3D = (
  swingFlipX: boolean | undefined,
  swingFlipY: boolean | undefined,
  isLocalPlusZIndoor: boolean,
  isAxisFlipped: boolean,
): { hingeXSign: number; openZSign: number } => {
  // 2D既定は p1側が吊り元。3DローカルXは isAxisFlipped(isCCW) で反転するため補正する。
  const hingeXSign = (isAxisFlipped ? 1 : -1) * (swingFlipX ? -1 : 1);
  // 既定は室内側(+Z=室内なら +1)へ。swingFlipY で内外反転。
  const openZSign = (isLocalPlusZIndoor ? 1 : -1) * (swingFlipY ? -1 : 1);
  return { hingeXSign, openZSign };
};

/**
 * 自由梁の壁⇔壁スパン計算。中心(cx,cy)から角度 angleDeg の軸±両方向へレイを飛ばし、
 * 最も近い壁エッジまでの距離を求め、壁から壁までを梁の長さとする。中心は2交点の中点へ寄せる。
 * 閉じていない/どちらかの方向で壁に当たらない場合は null（呼び出し側で自由移動にフォールバック）。
 * すべて mm 空間（points も cx/cy も mm）。2Dスケッチと3Dビューで共有する（260612）。
 */
export const computeWallToWallSpan = (
  points: Point[],
  closed: boolean,
  cx: number,
  cy: number,
  angleDeg: number,
): { cx: number; cy: number; lengthMm: number } | null => {
  if (points.length < 2) return null;
  const rad = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const edgeCount = closed ? points.length : points.length - 1;
  let tPos = Infinity;
  let tNeg = Infinity;
  for (let i = 0; i < edgeCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = ux * ey - uy * ex; // レイ方向 × エッジ方向
    if (Math.abs(denom) < 1e-9) continue; // 平行
    const rx = a.x - cx;
    const ry = a.y - cy;
    const t = (rx * ey - ry * ex) / denom; // レイ上の符号付き距離
    const s = (rx * uy - ry * ux) / denom; // エッジ上の媒介変数（0..1で線分内）
    if (s < -1e-6 || s > 1 + 1e-6) continue;
    if (t > 1e-6) tPos = Math.min(tPos, t);
    else if (t < -1e-6) tNeg = Math.min(tNeg, -t);
  }
  if (!Number.isFinite(tPos) || !Number.isFinite(tNeg)) return null;
  const lengthMm = tPos + tNeg;
  if (lengthMm < 1) return null;
  const midOffset = (tPos - tNeg) / 2;
  return { cx: cx + ux * midOffset, cy: cy + uy * midOffset, lengthMm };
};

export const getRoomTransform = (scaledPoints: Point[]): RoomTransformResult => {
  if (!scaledPoints.length) {
    return { centerScaled: { x: 0, y: 0 }, centerMm: { x: 0, y: 0 }, mPoints: [], isCCW: false };
  }

  const minX = Math.min(...scaledPoints.map((p) => p.x));
  const maxX = Math.max(...scaledPoints.map((p) => p.x));
  const minY = Math.min(...scaledPoints.map((p) => p.y));
  const maxY = Math.max(...scaledPoints.map((p) => p.y));
  const centerScaled = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const centerMm = { x: scaledToMm(centerScaled.x), y: scaledToMm(centerScaled.y) };

  const mPoints = scaledPoints.map((p) => ({
    x: (scaledToMm(p.x) - centerMm.x) / MM_PER_METER,
    z: (scaledToMm(p.y) - centerMm.y) / MM_PER_METER
  }));

  let areaSum = 0;
  for (let i = 0; i < mPoints.length; i += 1) {
    const a = mPoints[i];
    const b = mPoints[(i + 1) % mPoints.length];
    areaSum += a.x * b.z - b.x * a.z;
  }

  return { centerScaled, centerMm, mPoints, isCCW: areaSum < 0 };
};

export const furniturePositionToMm = (position: [number, number, number], centerMm: Point): Point => ({
  x: centerMm.x + position[0] * MM_PER_METER,
  y: centerMm.y + position[2] * MM_PER_METER
});

export const mmToFurniturePosition = (pointMm: Point, yMeters: number, centerMm: Point): [number, number, number] => ([
  (pointMm.x - centerMm.x) / MM_PER_METER,
  yMeters,
  (pointMm.y - centerMm.y) / MM_PER_METER
]);

// Canvas(2D) の角度はY軸下向きのため、3D yaw と符号が逆になる。
export const sketchAngleToYaw = (sketchAngleRad: number) => -sketchAngleRad;
export const yawToSketchRotation = (yawRad: number) => -yawRad;

/** 偶奇法（スケッチ平面 XY = 3D XZ と対応） */
export const pointInPolygon = (p: Point, poly: Point[]): boolean => {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const denom = yj - yi;
    if (Math.abs(denom) < 1e-12) continue;
    const intersect =
      (yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const getFurnitureBaseFootprintMm = (item: FurnitureItem) => {
  const key = `${item.type || ''} ${item.name || ''}`.toLowerCase();
  if (key.includes('sofa') || key.includes('ソファ')) return { width: 1800, depth: 900 };
  if (key.includes('table') || key.includes('desk') || key.includes('テーブル') || key.includes('デスク')) return { width: 1400, depth: 800 };
  if (key.includes('chair') || key.includes('チェア')) return { width: 600, depth: 600 };
  if (key.includes('bed') || key.includes('ベッド')) return { width: 2000, depth: 1400 };
  if (key.includes('shelf') || key.includes('cabinet') || key.includes('収納')) return { width: 900, depth: 450 };
  return { width: 1000, depth: 700 };
};

/** 2D/当たり判定用：異常寸法・非有限スケールを遮断（mm） */
const FOOTPRINT_MIN_MM = 200;
const FOOTPRINT_MAX_MM = 10000;

function clampFiniteScale(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.max(0.2, Math.min(50, v));
}

function clampFootprintDimensionsMm(width: number, depth: number): { width: number; depth: number } {
  let w = Number.isFinite(width) ? width : FOOTPRINT_MIN_MM;
  let d = Number.isFinite(depth) ? depth : FOOTPRINT_MIN_MM;
  w = Math.min(FOOTPRINT_MAX_MM, Math.max(FOOTPRINT_MIN_MM, w));
  d = Math.min(FOOTPRINT_MAX_MM, Math.max(FOOTPRINT_MIN_MM, d));
  return { width: w, depth: d };
}

/** SketchCanvas の足跡。modelFootprintBaseMm があれば GLTF 基準、なければ名前ヒューリスティクス */
export const getFurnitureFootprintMm = (item: FurnitureItem) => {
  const sx = clampFiniteScale(item.scale[0] ?? 1, 1);
  const sz = clampFiniteScale(item.scale[2] ?? sx, sx);
  if (item.footprint2d) {
    const rawW = Number.isFinite(item.footprint2d.width) ? item.footprint2d.width * sx : NaN;
    const rawD = Number.isFinite(item.footprint2d.depth) ? item.footprint2d.depth * sz : NaN;
    return clampFootprintDimensionsMm(rawW, rawD);
  }
  if (item.modelFootprintBaseMm) {
    const { width: bw, depth: bd } = item.modelFootprintBaseMm;
    const rawW = Number.isFinite(bw) ? bw * sx : NaN;
    const rawD = Number.isFinite(bd) ? bd * sz : NaN;
    return clampFootprintDimensionsMm(rawW, rawD);
  }
  const base = getFurnitureBaseFootprintMm(item);
  return clampFootprintDimensionsMm(base.width * sx, base.depth * sz);
};

/** getFurniturePoseMm と同じ yaw／幅・奥行きでローカル (±w/2,±d/2) を世界 mm に変換 */
export const furnitureFootprintCornersMm = (center: Point, yaw: number, widthMm: number, depthMm: number): Point[] => {
  const hw = widthMm / 2;
  const hd = depthMm / 2;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const locals = [
    { lx: hw, ly: hd },
    { lx: -hw, ly: hd },
    { lx: -hw, ly: -hd },
    { lx: hw, ly: -hd }
  ];
  return locals.map(({ lx, ly }) => ({
    x: center.x + lx * cos - ly * sin,
    y: center.y + lx * sin + ly * cos
  }));
};

export const isFurnitureFootprintInsidePolygon = (
  center: Point,
  yaw: number,
  widthMm: number,
  depthMm: number,
  poly: Point[]
): boolean => {
  if (poly.length < 3) return true;
  const corners = furnitureFootprintCornersMm(center, yaw, widthMm, depthMm);
  return corners.every((c) => pointInPolygon(c, poly));
};

const polygonBBox = (poly: Point[]) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  poly.forEach((p) => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });
  return { minX, maxX, minY, maxY };
};

/** 外形内の任意の内点（凹多角形でも粗いグリッドで探索） */
export const findAnyInteriorPointMm = (poly: Point[]): Point | null => {
  if (poly.length < 3) return null;
  const { minX, maxX, minY, maxY } = polygonBBox(poly);
  const dx = maxX - minX;
  const dy = maxY - minY;
  const step = Math.max(50, Math.min(dx, dy) / 25);
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      const p = { x, y };
      if (pointInPolygon(p, poly)) return p;
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return pointInPolygon({ x: cx, y: cy }, poly) ? { x: cx, y: cy } : null;
};

const findAnchorCenterForFootprint = (poly: Point[], yaw: number, widthMm: number, depthMm: number): Point | null => {
  const inner = findAnyInteriorPointMm(poly);
  if (!inner) return null;
  if (isFurnitureFootprintInsidePolygon(inner, yaw, widthMm, depthMm, poly)) return inner;
  const { minX, maxX, minY, maxY } = polygonBBox(poly);
  const step = Math.max(40, Math.min(maxX - minX, maxY - minY) / 30);
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      const p = { x, y };
      if (!pointInPolygon(p, poly)) continue;
      if (isFurnitureFootprintInsidePolygon(p, yaw, widthMm, depthMm, poly)) return p;
    }
  }
  return null;
};

/**
 * 提案中心が壁外に足跡を出す場合、多角形内の有効なアンカーへ向けて二分探索で中心を寄せる。
 */
export const clampFurnitureCenterMmToRoom = (
  proposed: Point,
  yaw: number,
  widthMm: number,
  depthMm: number,
  poly: Point[]
): Point => {
  if (poly.length < 3) return proposed;
  if (isFurnitureFootprintInsidePolygon(proposed, yaw, widthMm, depthMm, poly)) return proposed;
  const anchor = findAnchorCenterForFootprint(poly, yaw, widthMm, depthMm);
  if (!anchor) return proposed;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i += 1) {
    const mid = (lo + hi) / 2;
    const c = lerpPoint(anchor, proposed, mid);
    if (isFurnitureFootprintInsidePolygon(c, yaw, widthMm, depthMm, poly)) lo = mid;
    else hi = mid;
  }
  return lerpPoint(anchor, proposed, lo);
};

/**
 * ドラッグ中: 直前の有効中心から提案位置への線分上でクランプする。
 * 壁際で遠いアンカーへ飛ぶのを防ぎ、壁に沿って連続に追従する。
 */
export const clampFurnitureCenterMmToRoomAlongMotion = (
  previousValid: Point,
  proposed: Point,
  yaw: number,
  widthMm: number,
  depthMm: number,
  poly: Point[]
): Point => {
  if (poly.length < 3) return proposed;
  if (isFurnitureFootprintInsidePolygon(proposed, yaw, widthMm, depthMm, poly)) return proposed;
  if (isFurnitureFootprintInsidePolygon(previousValid, yaw, widthMm, depthMm, poly)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 32; i += 1) {
      const mid = (lo + hi) / 2;
      const c = lerpPoint(previousValid, proposed, mid);
      if (isFurnitureFootprintInsidePolygon(c, yaw, widthMm, depthMm, poly)) lo = mid;
      else hi = mid;
    }
    return lerpPoint(previousValid, proposed, lo);
  }
  return clampFurnitureCenterMmToRoom(proposed, yaw, widthMm, depthMm, poly);
};

const distSq = (a: Point, b: Point) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/**
 * 壁沿いスライド: 線分クランプ後、残り移動を各壁辺方向に投影して二次クランプする。
 */
export const slideFurnitureCenterMmWithWallContact = (
  previousValid: Point,
  proposed: Point,
  yaw: number,
  widthMm: number,
  depthMm: number,
  poly: Point[]
): Point => {
  if (poly.length < 3) return proposed;
  const c0 = clampFurnitureCenterMmToRoomAlongMotion(previousValid, proposed, yaw, widthMm, depthMm, poly);
  const residual = { x: proposed.x - c0.x, y: proposed.y - c0.y };
  if (Math.hypot(residual.x, residual.y) < 1) return c0;

  let best = c0;
  let bestD = distSq(c0, proposed);

  for (let i = 0; i < poly.length; i += 1) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    const edx = p2.x - p1.x;
    const edy = p2.y - p1.y;
    const elen = Math.hypot(edx, edy);
    if (elen < 1e-9) continue;
    const dir = { x: edx / elen, y: edy / elen };
    const t = residual.x * dir.x + residual.y * dir.y;
    const target = { x: c0.x + t * dir.x, y: c0.y + t * dir.y };
    const c1 = clampFurnitureCenterMmToRoomAlongMotion(c0, target, yaw, widthMm, depthMm, poly);
    const d = distSq(c1, proposed);
    if (d < bestD - 1e-6) {
      bestD = d;
      best = c1;
    }
  }

  return best;
};

/** 家具1件の position を部屋ポリゴン内にクランプ（スケッチ平面 mm） */
export const clampFurnitureItemToRoom = (item: FurnitureItem, centerMm: Point, polygonMm: Point[]): FurnitureItem => {
  if (polygonMm.length < 3) return item;
  const { width, depth } = getFurnitureFootprintMm(item);
  const yaw = item.rotation[1] || 0;
  const center = furniturePositionToMm(item.position, centerMm);
  const nextCenter = clampFurnitureCenterMmToRoom(center, yaw, width, depth, polygonMm);
  if (nextCenter.x === center.x && nextCenter.y === center.y) return item;
  return {
    ...item,
    position: mmToFurniturePosition(nextCenter, item.position[1], centerMm)
  };
};

export const clampAllFurnitureToRoom = (items: FurnitureItem[], centerMm: Point, polygonMm: Point[]): FurnitureItem[] =>
  items.map((item) => clampFurnitureItemToRoom(item, centerMm, polygonMm));
