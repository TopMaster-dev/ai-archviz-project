// 用紙サイズ書き出し（第3段・260703 クライアント合意）。
// Gemini は用紙比率(A系=1:1.414)を直接サポートしないため、画像は「対応比率」で生成し、
// 書き出し時に用紙サイズのキャンバスへ余白付き(contain)で配置する（生成し直さないので構図は不変）。
// 実際の配置は既存の fitDataUrlToSize(..., 'contain', 白) を用いる（本ファイルは寸法計算のみ）。

export type PaperSize = 'A4' | 'A3';

export type PaperOrientation = 'portrait' | 'landscape';

/** A系用紙の実寸（mm）。short=短辺, long=長辺。A4≈210×297, A3≈297×420（いずれも長辺/短辺≈√2=1.414）。 */
export const PAPER_MM: Record<PaperSize, { short: number; long: number }> = {
  A4: { short: 210, long: 297 },
  A3: { short: 297, long: 420 },
};

const mmToPx = (mm: number, dpi: number) => Math.max(1, Math.round((mm / 25.4) * dpi));

/** 用紙のピクセル寸法（dpi・向き指定）。横向きは長辺=幅、縦向きは長辺=高さ。 */
export function paperPixelDims(paper: PaperSize, dpi: number, orientation: PaperOrientation): { w: number; h: number } {
  const { short, long } = PAPER_MM[paper];
  const s = mmToPx(short, dpi);
  const l = mmToPx(long, dpi);
  return orientation === 'landscape' ? { w: l, h: s } : { w: s, h: l };
}

/** 画像の向きに合わせた用紙の向き（横長画像→横向き用紙）。正方は縦向き扱い。 */
export function orientationForImage(width: number, height: number): PaperOrientation {
  return width > height ? 'landscape' : 'portrait';
}

/** 用紙の縦横比（幅/高さ）。表示・検証用。 */
export function paperAspectRatio(paper: PaperSize, orientation: PaperOrientation): number {
  const { short, long } = PAPER_MM[paper];
  return orientation === 'landscape' ? long / short : short / long;
}
