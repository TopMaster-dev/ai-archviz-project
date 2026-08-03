/**
 * 下絵（図面）を実寸へ合わせるための換算（260803 クライアント要望・管理表124行目）。
 *
 * 【考え方】
 * 図面は「どの用紙に、どの縮尺で描かれたか」が分かれば実寸が決まる。
 *   用紙の実寸(mm) ÷ 画像の画素数(px) = 用紙上の mm/px
 *   用紙上の mm/px × 縮尺の分母 = 現実の mm/px
 * 例: A3横(420mm)を 3000px で取り込み、縮尺 1/100 なら
 *   420 / 3000 = 0.14 mm/px（用紙上）→ 0.14 × 100 = 14 mm/px（現実）
 *   つまり画像全体で 3000 × 14 = 42,000mm = 42m を表す。
 *
 * PDFはファイル自身が用紙寸法を持っているため、用紙上の mm/px を直接取得できる
 * （utils/pdfToImage.ts の paperMmPerPx）。画像（JPEG/PNG）は用紙情報を持たないので、
 * 利用者に用紙サイズを選んでいただき、ここで換算する。
 */

export interface PaperSize {
  id: string;
  label: string;
  /** 短辺・長辺（mm）。向きは別途決める。 */
  shortMm: number;
  longMm: number;
}

/** 図面で使う用紙（クライアント資料の指定どおり A0〜A3）。 */
export const PAPER_SIZES: PaperSize[] = [
  { id: 'A0', label: 'A0', shortMm: 841, longMm: 1189 },
  { id: 'A1', label: 'A1', shortMm: 594, longMm: 841 },
  { id: 'A2', label: 'A2', shortMm: 420, longMm: 594 },
  { id: 'A3', label: 'A3', shortMm: 297, longMm: 420 },
];

/** よく使う縮尺（資料の指定）。これ以外は任意入力で受ける。 */
export const SCALE_PRESETS = [50, 100, 200] as const;

export function paperSizeById(id: string): PaperSize | null {
  return PAPER_SIZES.find((p) => p.id === id) ?? null;
}

/**
 * 画像の縦横比から用紙の向きを決める（260803・クライアント指定「縦横比から自動判定」）。
 * 横長の画像なら横向き（長辺が幅）、縦長なら縦向き。正方形は横向き扱い。
 */
export function paperMmForImage(paper: PaperSize, imageW: number, imageH: number): { widthMm: number; heightMm: number } {
  const landscape = imageW >= imageH;
  return landscape
    ? { widthMm: paper.longMm, heightMm: paper.shortMm }
    : { widthMm: paper.shortMm, heightMm: paper.longMm };
}

/**
 * 用紙上の mm/px。画像の幅を基準にする（縦横比が用紙と完全一致しない取り込みでも、
 * 幅で合わせておけば図面の横方向の寸法が正しくなる）。
 */
export function paperMmPerPxForImage(paper: PaperSize, imageW: number, imageH: number): number | null {
  if (!(imageW > 0) || !(imageH > 0)) return null;
  const { widthMm } = paperMmForImage(paper, imageW, imageH);
  return widthMm / imageW;
}

/** 現実の mm/px（＝下絵の scaleMmPerPx）。用紙上の mm/px × 縮尺の分母。 */
export function realMmPerPx(paperMmPerPx: number, scaleDenominator: number): number | null {
  if (!(paperMmPerPx > 0) || !(scaleDenominator > 0)) return null;
  return paperMmPerPx * scaleDenominator;
}

/**
 * PDFから得た「用紙上の mm/px」と画像の画素数から、どの規格用紙かを推定する（挿入ダイアログの初期選択用）。
 *
 * PDFは用紙の実寸を持っているので、幅(mm) = mm/px × 画素幅 で用紙の実寸が出る。
 * それを A0〜A3 の実寸（向きは画像の縦横比で判定）と比べ、最も近いものを返す。
 * どれとも大きく外れる場合（規格外の用紙）は null を返し、利用者に選んでいただく。
 */
export function detectPaperIdFromMmPerPx(
  paperMmPerPx: number,
  imageW: number,
  imageH: number,
): string | null {
  if (!(paperMmPerPx > 0) || !(imageW > 0) || !(imageH > 0)) return null;
  const actualWidthMm = paperMmPerPx * imageW;
  let best: { id: string; diff: number } | null = null;
  for (const p of PAPER_SIZES) {
    const { widthMm } = paperMmForImage(p, imageW, imageH);
    const diff = Math.abs(widthMm - actualWidthMm) / widthMm;
    if (!best || diff < best.diff) best = { id: p.id, diff };
  }
  // 5%以上ずれていれば規格用紙とは言えない（トリミング済み・規格外）。
  return best && best.diff <= 0.05 ? best.id : null;
}

/**
 * 「1/150」「1:150」「150」といった入力から縮尺の分母を取り出す。
 * 資料の任意入力欄がこの3通りのいずれでも書かれ得るため、まとめて受ける。
 * 解釈できない・0以下は null（呼び出し側で入力エラーとして扱う）。
 */
export function parseScaleDenominator(input: string): number | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  // 全角の数字・スラッシュ・コロンを半角へ寄せる（図面の資料は全角で書かれることがある）。
  const half = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/／/g, '/').replace(/：/g, ':');
  const m = half.match(/^(?:1\s*[/:]\s*)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const denom = Number(m[1]);
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return denom;
}
