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
