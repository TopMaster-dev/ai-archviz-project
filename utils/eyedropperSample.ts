import { rgbToHex } from './colorConvert.js';

/**
 * アプリ内スポイトの純粋なピクセル座標変換 + 色読取（260709）。
 * アプリ自身が描いている canvas / img から色を読む（ブラウザのスクリーンキャプチャは使わない）ので、
 * ネイティブスポイトの固まりとは無関係。
 */

export type ObjectFit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down' | string;

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 表示中の要素上のクリック位置(client座標)を、元画像のピクセル座標へ変換する。
 * object-fit（contain/cover/none/scale-down/fill）を考慮。レターボックス余白や範囲外は null。
 */
export function mapPointToSourcePixel(
  rect: RectLike,
  naturalW: number,
  naturalH: number,
  objectFit: ObjectFit,
  clientX: number,
  clientY: number
): { sx: number; sy: number } | null {
  if (naturalW <= 0 || naturalH <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const dx = clientX - rect.left;
  const dy = clientY - rect.top;
  if (dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return null;

  let contentW = rect.width;
  let contentH = rect.height;
  let offX = 0;
  let offY = 0;

  if (objectFit === 'contain' || objectFit === 'scale-down') {
    let scale = Math.min(rect.width / naturalW, rect.height / naturalH);
    if (objectFit === 'scale-down') scale = Math.min(scale, 1);
    contentW = naturalW * scale;
    contentH = naturalH * scale;
    offX = (rect.width - contentW) / 2;
    offY = (rect.height - contentH) / 2;
  } else if (objectFit === 'cover') {
    const scale = Math.max(rect.width / naturalW, rect.height / naturalH);
    contentW = naturalW * scale;
    contentH = naturalH * scale;
    offX = (rect.width - contentW) / 2;
    offY = (rect.height - contentH) / 2;
  } else if (objectFit === 'none') {
    contentW = naturalW;
    contentH = naturalH;
    offX = (rect.width - contentW) / 2;
    offY = (rect.height - contentH) / 2;
  }
  // 'fill'（既定）は content = rect いっぱい

  const cx = dx - offX;
  const cy = dy - offY;
  if (cx < 0 || cy < 0 || cx > contentW || cy > contentH) return null; // レターボックス余白部

  const sx = Math.floor((cx / contentW) * naturalW);
  const sy = Math.floor((cy / contentH) * naturalH);
  return {
    sx: Math.min(naturalW - 1, Math.max(0, sx)),
    sy: Math.min(naturalH - 1, Math.max(0, sy)),
  };
}

/** クリック地点から色を読める要素（canvas/img）ならそれを返す。無ければ null。 */
export function findSamplableElement(
  el: Element | null
): HTMLCanvasElement | HTMLImageElement | null {
  if (!el) return null;
  if (el instanceof HTMLCanvasElement || el instanceof HTMLImageElement) return el;
  return null;
}

/**
 * クリック地点(client座標)にある要素を「上から順に」見て、最初の canvas/img を返す。
 * pointer-events を持たない装飾DOM（ツールチップ等）が上に重なっていても、その下の
 * 3Dキャンバス/画像を拾えるようにするため elementsFromPoint を使う（無ければ elementFromPoint）。
 */
export function findSamplableAtPoint(
  clientX: number,
  clientY: number
): HTMLCanvasElement | HTMLImageElement | null {
  if (typeof document === 'undefined') return null;
  let list: Element[] = [];
  if (typeof document.elementsFromPoint === 'function') {
    list = document.elementsFromPoint(clientX, clientY);
  } else if (typeof document.elementFromPoint === 'function') {
    const el = document.elementFromPoint(clientX, clientY);
    if (el) list = [el];
  }
  for (const el of list) {
    const s = findSamplableElement(el);
    if (s) return s;
  }
  return null;
}

/**
 * 表示中の canvas / img の、クリック位置のピクセル色を hex で返す。読めなければ null。
 * - 3D canvas は preserveDrawingBuffer:true なので drawImage で現在フレームを取得できる。
 * - クロスオリジン画像で getImageData が拒否（タインテッド）された場合などは null（安全に無視）。
 */
export function readPixelHex(
  el: HTMLCanvasElement | HTMLImageElement,
  clientX: number,
  clientY: number
): string | null {
  const rect = el.getBoundingClientRect();
  const isImg = typeof HTMLImageElement !== 'undefined' && el instanceof HTMLImageElement;
  const naturalW = isImg ? (el as HTMLImageElement).naturalWidth : (el as HTMLCanvasElement).width;
  const naturalH = isImg ? (el as HTMLImageElement).naturalHeight : (el as HTMLCanvasElement).height;

  let objectFit: ObjectFit = 'fill';
  try {
    objectFit = (getComputedStyle(el).objectFit as ObjectFit) || 'fill';
  } catch {
    /* jsdom 等では getComputedStyle が不完全 */
  }

  const src = mapPointToSourcePixel(
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    naturalW,
    naturalH,
    objectFit,
    clientX,
    clientY
  );
  if (!src) return null;

  const tmp = document.createElement('canvas');
  tmp.width = naturalW;
  tmp.height = naturalH;
  const ctx = tmp.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(el, 0, 0, naturalW, naturalH);
    const d = ctx.getImageData(src.sx, src.sy, 1, 1).data;
    return rgbToHex(d[0], d[1], d[2]);
  } catch {
    return null; // タインテッド(クロスオリジン)や描画不可
  }
}
