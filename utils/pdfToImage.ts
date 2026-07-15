import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * PDF の1ページ目をラスタライズして PNG の dataURL を返す。
 * pdfjs 本体は動的 import でコード分割し、PDF を選んだときだけ読み込む（初期バンドルを軽く保つ）。
 *
 * @param scale 描画スケール（大きいほど高精細・重い）。下絵用途では 2 程度で十分。
 */
export async function pdfFirstPageToDataUrl(file: File, scale = 2): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context is unavailable');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/png');
  } finally {
    await pdf.cleanup();
  }
}

/** 1pt = 25.4/72 mm（PDF のユーザー空間単位＝ポイント）。 */
const MM_PER_PT = 25.4 / 72;

export interface PdfPageRaster {
  dataUrl: string;
  /**
   * ラスタライズ1pxあたりの「用紙上の」mm（縮尺1:1）。ページは pt 単位で、scale 倍で描画したので
   * 1描画px = (1/scale)pt = MM_PER_PT/scale mm（用紙上・ページ寸法に依らない）。
   * 図面の縮尺 1:denom を適用するときの実寸 mm/px は paperMmPerPx × denom（#5a・260715）。
   */
  paperMmPerPx: number;
}

/**
 * PDFの1ページ目をラスタライズし、下絵の実寸合わせに必要な paperMmPerPx（用紙mm/px）も返す。
 * これに図面の縮尺(1:denom)を掛ければ実寸 scaleMmPerPx が求まり、用紙サイズ＋縮尺で下絵を正しいサイズにできる。
 */
export async function pdfFirstPageToUnderlay(file: File, scale = 2): Promise<PdfPageRaster> {
  const dataUrl = await pdfFirstPageToDataUrl(file, scale);
  return { dataUrl, paperMmPerPx: MM_PER_PT / scale };
}
