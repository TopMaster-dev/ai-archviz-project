import type { NormalizedRect } from '../types.js';

/**
 * エリア編集の精度向上（260702）: マスク領域だけをクロップして拡大送信するための純粋な座標計算。
 *
 * 背景: 従来はベース画像全体（~1K）を Gemini に再生成させ、マスクはテキスト頂点でしか伝えていなかった。
 * 画面の 15〜20% しかない小さな領域は、全体1Kパスの中では実効解像度が低く、家具が重なると前後を
 * 分離しきれず「溶けた」出力になる（当たり外れが激しい）。マスクの外接矩形＋余白でクロップして拡大送信
 * すると、対象領域がフレームいっぱいに写り実効解像度が上がる＝精度・安定性が上がる。
 *
 * ここに置くのは canvas を使わない純関数のみ（ユニットテスト可能）。実際の画素処理は cropPasteCanvas.ts。
 */

/** 領域クロップの調整定数（実機QAでチューニングする想定）。 */
export const PAD_FRAC = 0.35; // マスク外接矩形の各辺に足す余白（周囲の文脈＝奥行き手がかりを確保）
export const SKIP_CROP_COVERAGE = 0.85; // クロップが画面の 85% 超を占めるならクロップしない（利得なし＋継ぎ目リスク）
export const MIN_SKIP_BBOX_COVERAGE = 0.6; // マスク自体が画面の 60% 超ならクロップしない
export const MIN_CROP_PX = 64; // クロップ辺が 64px 未満なら拡大しすぎでボケるのでクロップしない

/**
 * 「大領域」の判定しきい値（union マスク外接矩形が画面のこの割合以上・260707 クライアント要望）。
 * 大領域はクロップして貼り戻すと大きな継ぎ目（境界線）になる。この場合はクロップせず、全画面をそのまま
 * 編集した結果を（合成せず）1枚として使う＝継ぎ目が生じない。小領域はクロップ＋合成＋色合わせで精度を優先。
 * 0.10 の根拠（260707 検証）: クライアント報告事例（3矩形の家具差し替え）の union bbox が約 0.12。ここを確実に
 * 拾いつつ、通常の単品家具（約 0.08〜0.09）は安全な合成経路に残す境目。値は実機QAで調整可能。
 */
export const LARGE_REGION_COVERAGE = 0.1;

/**
 * 全ケース全画面1回生成の「標準」化フラグ（260707 クライアント要望＝試験導入）。
 * true: 選択サイズに関わらず、すべてのエリア編集を全画面1回生成にする（クロップ・貼り戻し・合成・なじませを
 *       通さない＝境界線が構造的に生じない・フォーカスプロンプト＋事前解析で編集精度を担保）。
 * false: 従来動作へロールバック（10%未満はクロップ＋合成＋色合わせ＝範囲外バイト保持・小領域の実効解像度確保）。
 * ※ 問題時に false へ倒せば即座に従来経路へ戻せるよう、合成/クロップ/なじませのコードは削除せず残す。
 */
export const ENABLE_FULLFRAME_ONLY = true;

/** union マスク外接矩形が「大領域」か（＝クロップ/合成せず全画面編集を使う）。純関数。 */
export function isLargeRegion(bbox: BBox01, threshold = LARGE_REGION_COVERAGE): boolean {
  return bbox.w * bbox.h >= threshold;
}

/** 正規化 0..1 の矩形。 */
export interface BBox01 {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 整数ピクセルのクロップ矩形。 */
export interface CropPx {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 全 placements（多角形は頂点、矩形は x/y/w/h）の外接矩形（正規化 0..1）。空なら全画面。 */
export function unionBBoxOfPlacements(placements: NormalizedRect[]): BBox01 {
  if (!placements || placements.length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placements) {
    if (p.points && p.points.length >= 3) {
      for (const pt of p.points) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
    } else {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.width);
      maxY = Math.max(maxY, p.y + p.height);
    }
  }
  if (![minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) return { x: 0, y: 0, w: 1, h: 1 };
  minX = clamp01(minX);
  minY = clamp01(minY);
  maxX = clamp01(maxX);
  maxY = clamp01(maxY);
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/** bbox を padFrac*max(w,h) だけ各辺に広げ、0..1 にクランプ（周囲の文脈を確保）。 */
export function padBBox(bbox: BBox01, padFrac = PAD_FRAC): BBox01 {
  const pad = padFrac * Math.max(bbox.w, bbox.h);
  const x0 = clamp01(bbox.x - pad);
  const y0 = clamp01(bbox.y - pad);
  const x1 = clamp01(bbox.x + bbox.w + pad);
  const y1 = clamp01(bbox.y + bbox.h + pad);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** "16:9" → 16/9（W/H）。不正時は 16/9。 */
export function parseAspectRatioKey(key: string): number {
  const m = (key || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return 16 / 9;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!(w > 0) || !(h > 0)) return 16 / 9;
  return w / h;
}

/**
 * bbox(0..1) を、targetAspect(W/H) の整数ピクセルクロップに「拡大のみ」で合わせる。
 * 不変条件: 元の bbox を必ず内包（縮小しない）、画像内に完全収容（辺に当たったら中心を内側にずらす）。
 * targetAspect が画像に収まらない極端ケースは、内包を優先し画像サイズで頭打ち（アスペクトは近似）。
 */
export function snapCropToAspect(bbox: BBox01, imgW: number, imgH: number, targetAspect: number): CropPx {
  // bbox を確実に内包する整数ピクセル矩形（floor/ceil）。
  let x0 = Math.max(0, Math.min(imgW, Math.floor(bbox.x * imgW)));
  let y0 = Math.max(0, Math.min(imgH, Math.floor(bbox.y * imgH)));
  let x1 = Math.max(0, Math.min(imgW, Math.ceil((bbox.x + bbox.w) * imgW)));
  let y1 = Math.max(0, Math.min(imgH, Math.ceil((bbox.y + bbox.h) * imgH)));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;

  const ta = targetAspect > 0 ? targetAspect : w / h;
  // 拡大のみで目標アスペクトへ（短い方の辺を伸ばす）。
  let tw = w;
  let th = h;
  if (w / h < ta) tw = Math.round(h * ta);
  else th = Math.round(w / ta);
  // 画像サイズで頭打ち（内包は維持: tw>=w, th>=h）。
  tw = Math.max(w, Math.min(tw, imgW));
  th = Math.max(h, Math.min(th, imgH));

  // bbox 中心にそろえ、はみ出したら内側へシフト（縮小しない）。
  let sx = Math.round(cx - tw / 2);
  let sy = Math.round(cy - th / 2);
  if (sx < 0) sx = 0;
  if (sy < 0) sy = 0;
  if (sx + tw > imgW) sx = imgW - tw;
  if (sy + th > imgH) sy = imgH - th;
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  const sw = Math.min(tw, imgW - sx);
  const sh = Math.min(th, imgH - sy);
  return { sx, sy, sw, sh };
}

/** 画像全体の正規化座標を、クロップ内の正規化座標へ写す（多角形は頂点、矩形は x/y/w/h を再計算）。 */
export function remapPlacementsToCrop(
  placements: NormalizedRect[],
  crop: CropPx,
  imgW: number,
  imgH: number
): NormalizedRect[] {
  const { sx, sy, sw, sh } = crop;
  const mapX = (nx: number) => clamp01((nx * imgW - sx) / sw);
  const mapY = (ny: number) => clamp01((ny * imgH - sy) / sh);
  return placements.map((p) => {
    if (p.points && p.points.length >= 3) {
      const points = p.points.map((pt) => ({ x: mapX(pt.x), y: mapY(pt.y) }));
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const pt of points) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, points };
    }
    const x0 = mapX(p.x);
    const y0 = mapY(p.y);
    const x1 = mapX(p.x + p.width);
    const y1 = mapY(p.y + p.height);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  });
}

/** remapPlacementsToCrop の逆写像（クロップ内正規化 → 画像全体正規化）。ラウンドトリップ検証用。 */
export function cropToImageNorm(
  nx: number,
  ny: number,
  crop: CropPx,
  imgW: number,
  imgH: number
): { x: number; y: number } {
  return { x: (crop.sx + nx * crop.sw) / imgW, y: (crop.sy + ny * crop.sh) / imgH };
}

/** クロップを実行すべきか（利得のない／過拡大になるケースは false＝従来の全画面パスへフォールバック）。 */
export function shouldCropRegion(bbox: BBox01, crop: CropPx, baseW: number, baseH: number): boolean {
  if (baseW <= 0 || baseH <= 0) return false;
  const coverage = (crop.sw * crop.sh) / (baseW * baseH);
  if (coverage > SKIP_CROP_COVERAGE) return false; // 画面の大半＝クロップの利得なし
  if (bbox.w * bbox.h > MIN_SKIP_BBOX_COVERAGE) return false; // マスク自体が大きい
  if (crop.sw < MIN_CROP_PX || crop.sh < MIN_CROP_PX) return false; // 小さすぎ＝過拡大でボケる
  return true;
}
