/**
 * 下絵（図面）を実寸へ合わせるための換算（260803 クライアント要望・管理表124行目、260804 資料で仕様確定）。
 *
 * 【考え方】
 * 図面は「どの用紙に、どの縮尺で描かれたか」が分かれば実寸が決まる。
 *   用紙の実寸(mm) ÷ 画像の画素数(px) = 用紙上の mm/px
 *   用紙上の mm/px × 縮尺の分母 = 現実の mm/px
 * 例: A3横(420mm)を 3000px で取り込み、縮尺 1/100 なら
 *   420 / 3000 = 0.14 mm/px（用紙上）→ 0.14 × 100 = 14 mm/px（現実）
 *   つまり画像全体で 3000 × 14 = 42,000mm = 42m を表す。
 *
 * PDFはファイル自身が用紙寸法を持つため用紙上の mm/px を直接取得できる（utils/pdfToImage.ts）。
 * 画像（JPEG/PNG）は用紙情報を持たないので、利用者に用紙サイズを選んでいただく。
 *
 * 【260804 クライアント指定】
 *  - 用紙は横（ランドスケープ）想定。長辺を幅として扱う。
 *  - 読み込んだファイルの縦横比がA判（1:1.414）でない場合は「カスタム（手入力）」にする。
 */

export interface PaperSize {
  id: string;
  label: string;
  /** 短辺・長辺（mm）。用紙は横想定なので、幅＝長辺・高さ＝短辺として使う。 */
  shortMm: number;
  longMm: number;
}

/** 「カスタム（手入力）」を表す用紙ID。幅(mm)を利用者が直接入力する。 */
export const CUSTOM_PAPER_ID = 'custom';

/** A判の縦横比（長辺÷短辺）。用紙かどうかの判定に使う。 */
export const A_SERIES_RATIO = Math.SQRT2;

/** 図面で使う用紙（クライアント資料の指定どおり A0〜A3）。 */
export const PAPER_SIZES: PaperSize[] = [
  { id: 'A0', label: 'A0', shortMm: 841, longMm: 1189 },
  { id: 'A1', label: 'A1', shortMm: 594, longMm: 841 },
  { id: 'A2', label: 'A2', shortMm: 420, longMm: 594 },
  { id: 'A3', label: 'A3', shortMm: 297, longMm: 420 },
];

/** 縮尺の選択肢（クライアント資料の指定どおり）。 */
export const SCALE_DENOMINATORS = [10, 20, 30, 50, 100, 150, 200, 250, 300, 500] as const;

/** 下絵の位置を測る基準の角。 */
export type UnderlayAnchor = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export const ANCHOR_OPTIONS: Array<{ id: UnderlayAnchor; label: string }> = [
  { id: 'topLeft', label: '左上' },
  { id: 'topRight', label: '右上' },
  { id: 'bottomLeft', label: '左下' },
  { id: 'bottomRight', label: '右下' },
];

export function paperSizeById(id: string): PaperSize | null {
  return PAPER_SIZES.find((p) => p.id === id) ?? null;
}

/**
 * 用紙の実寸（mm）。用紙は横想定なので、常に長辺が幅・短辺が高さ。
 * （260804 クライアント指定「用紙は横想定」）
 */
export function paperMmLandscape(paper: PaperSize): { widthMm: number; heightMm: number } {
  return { widthMm: paper.longMm, heightMm: paper.shortMm };
}

/**
 * 読み込んだ画像の縦横比がA判（1:1.414）と言えるか。
 * 用紙は横想定なので 幅÷高さ ≈ √2 を見る。
 * 外れていれば規格用紙ではない（トリミング済み・長尺図面など）ため「カスタム」にする。
 */
export function isStandardPaperAspect(imageW: number, imageH: number, tolerance = 0.03): boolean {
  if (!(imageW > 0) || !(imageH > 0)) return false;
  const ratio = imageW / imageH;
  return Math.abs(ratio - A_SERIES_RATIO) / A_SERIES_RATIO <= tolerance;
}

/** 用紙上の mm/px（幅基準）。用紙は横想定。 */
export function paperMmPerPxForImage(paper: PaperSize, imageW: number): number | null {
  if (!(imageW > 0)) return null;
  return paperMmLandscape(paper).widthMm / imageW;
}

/** 幅(mm) を直接指定したときの用紙上 mm/px（カスタム用紙用）。 */
export function paperMmPerPxFromWidth(paperWidthMm: number, imageW: number): number | null {
  if (!(paperWidthMm > 0) || !(imageW > 0)) return null;
  return paperWidthMm / imageW;
}

/** 現実の mm/px（＝下絵の scaleMmPerPx）。用紙上の mm/px × 縮尺の分母。 */
export function realMmPerPx(paperMmPerPx: number, scaleDenominator: number): number | null {
  if (!(paperMmPerPx > 0) || !(scaleDenominator > 0)) return null;
  return paperMmPerPx * scaleDenominator;
}

/**
 * 「1/150」「1:150」「150」といった入力から縮尺の分母を取り出す。
 * 図面資料が全角で書かれることがあるため、全角の数字・スラッシュ・コロンも受ける。
 * 解釈できない・0以下は null（呼び出し側で入力エラーとして扱う）。
 */
export function parseScaleDenominator(input: string): number | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  const half = s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/／/g, '/')
    .replace(/：/g, ':');
  const m = half.match(/^(?:1\s*[/:]\s*)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const denom = Number(m[1]);
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return denom;
}

/**
 * PDFから得た「用紙上の mm/px」と画像の画素幅から、どの規格用紙かを推定する。
 * PDFは用紙の実寸を持っているので 幅(mm) = mm/px × 画素幅 で用紙が特定できる。
 * 規格から5%以上外れていれば「カスタム」（長尺図面・トリミング済みなど）。
 */
export function detectPaperIdFromMmPerPx(paperMmPerPx: number, imageW: number): string {
  if (!(paperMmPerPx > 0) || !(imageW > 0)) return CUSTOM_PAPER_ID;
  const actualWidthMm = paperMmPerPx * imageW;
  let best: { id: string; diff: number } | null = null;
  for (const p of PAPER_SIZES) {
    const widthMm = paperMmLandscape(p).widthMm;
    const diff = Math.abs(widthMm - actualWidthMm) / widthMm;
    if (!best || diff < best.diff) best = { id: p.id, diff };
  }
  return best && best.diff <= 0.05 ? best.id : CUSTOM_PAPER_ID;
}

/**
 * 画像（用紙情報を持たない）を取り込んだときの用紙の初期選択。
 * 縦横比がA判なら A3 を初期値にし、そうでなければカスタム（手入力）。
 * ※画像だけではA0〜A3のどれかまでは判別できない（A判はどれも同じ縦横比のため）。
 */
export function initialPaperIdForImage(imageW: number, imageH: number): string {
  return isStandardPaperAspect(imageW, imageH) ? 'A3' : CUSTOM_PAPER_ID;
}

/**
 * 基準点（どの角を基準に位置を測るか）と、その角の座標から、下絵の左上座標を求める。
 * 2Dスケッチの座標系は Y が下向きに増える。
 */
export function offsetFromAnchor(
  anchor: UnderlayAnchor,
  x: number,
  y: number,
  widthMm: number,
  heightMm: number,
): { offsetX: number; offsetY: number } {
  const w = Math.max(0, widthMm);
  const h = Math.max(0, heightMm);
  return {
    offsetX: anchor === 'topRight' || anchor === 'bottomRight' ? x - w : x,
    offsetY: anchor === 'bottomLeft' || anchor === 'bottomRight' ? y - h : y,
  };
}

/** 左上座標から、指定した基準点の座標を求める（offsetFromAnchor の逆）。 */
export function anchorFromOffset(
  anchor: UnderlayAnchor,
  offsetX: number,
  offsetY: number,
  widthMm: number,
  heightMm: number,
): { x: number; y: number } {
  const w = Math.max(0, widthMm);
  const h = Math.max(0, heightMm);
  return {
    x: anchor === 'topRight' || anchor === 'bottomRight' ? offsetX + w : offsetX,
    y: anchor === 'bottomLeft' || anchor === 'bottomRight' ? offsetY + h : offsetY,
  };
}
