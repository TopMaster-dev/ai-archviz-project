// legacy ビルドを使う（260728 クライアント #4 の本命修正）。
// 既定の modern ビルド（build/pdf.mjs）は core-js ポリフィルを含まず Promise.withResolvers() を
// 直接呼ぶため、Chrome/Edge <119・Firefox <121・Safari <17.4 では getDocument() が即 TypeError になり
// 「下絵の読み込みに失敗しました」になっていた（最新Chromeでは再現しないため環境依存に見えていた）。
// legacy ビルドはポリフィル同梱（core-js マーカー実測 45箇所 / modern は 0）。
// 動的 import なのでサイズ増は PDF を選んだときだけで、初期表示には影響しない。
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

/** legacy ビルドは型定義を持たないため、型はパッケージ本体の宣言を借りる。 */
type PdfjsModule = typeof import('pdfjs-dist');

/**
 * 「そのままユーザーに見せてよい」日本語メッセージを持つエラー。
 * これでタグ付けしておかないと、呼び出し側が全例外の message を表示してしまい、
 * 画像読込の DOMException（英語）などがそのままトーストに出る（260728 敵対レビュー指摘）。
 */
export class UnderlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnderlayError';
  }
}

/**
 * ラスタライズの上限。A1/A0 の図面を固定 scale=2 で焼くと 16〜32MP のキャンバスになり、
 *  - ブラウザのキャンバス上限/メモリで render や toDataURL が失敗する
 *  - 成功しても数十MBの base64 になり、下絵はプロジェクトへ保存される（projectState.underlayPlan）ため
 *    保存・読込・複製が極端に重くなる
 * という二重の問題があった（260728 クライアント #4「PDFを選ぶと下絵の読み込みに失敗しました」）。
 * 下絵はトレース用なので 4096px/12MP で十分な解像度が出る:
 *   A1 = 4.9px/mm、A0 = 3.4px/mm。A4〜A2 は上限に掛からず従来どおり scale=2（5.7px/mm）のまま変わらない。
 */
const MAX_RASTER_SIDE_PX = 4096;
const MAX_RASTER_PIXELS = 12_000_000;

/**
 * 要求スケールを、上限に収まる実効スケールへ落とす（1pt あたりの元寸から算出）。
 * 下限（0.01）は上限より内側にだけ効かせる。上限より外に置くと、極端に大きな MediaBox
 * （pdfjs は仕様上限を強制しない）で下限が上限に勝ち、防ぎたかった巨大キャンバスに戻ってしまう。
 * 拡大は決してしない（desiredScale を超えない）。
 */
export function fitRasterScale(baseWidthPt: number, baseHeightPt: number, desiredScale: number): number {
  if (!(baseWidthPt > 0) || !(baseHeightPt > 0) || !(desiredScale > 0)) return 1;
  const bySide = Math.min(MAX_RASTER_SIDE_PX / baseWidthPt, MAX_RASTER_SIDE_PX / baseHeightPt);
  const byArea = Math.sqrt(MAX_RASTER_PIXELS / (baseWidthPt * baseHeightPt));
  const cap = Math.max(0.01, Math.min(bySide, byArea));
  return Math.min(desiredScale, cap);
}

/**
 * 取り込むページ番号を、実在するページ（1〜pageCount）へ丸める。
 * 範囲外を pdfjs に渡すと例外になるが、ここはユーザーの選択なのでエラーにせず、
 * 一番近い実在ページへ寄せる（260805 のページ選択で、前ページ数より少ないPDFに
 * 差し替わった場合などに空白ページを掴まない）。
 */
export function clampPageNumber(pageNumber: number, pageCount: number): number {
  const total = Math.max(1, Math.floor(pageCount) || 1);
  if (!Number.isFinite(pageNumber)) return 1;
  return Math.min(Math.max(1, Math.round(pageNumber)), total);
}

export interface PdfRasterResult {
  dataUrl: string;
  /** 実際に使ったスケール（上限で切り下げられている場合がある）。mm/px の算出はこの値で行うこと。 */
  usedScale: number;
  /** PDF の総ページ数（260805 クライアント要望・複数ページなら何枚目を取り込むか選ばせる）。 */
  pageCount: number;
}

/**
 * PDF の1ページ目をラスタライズして PNG の dataURL を返す。
 * pdfjs 本体は動的 import でコード分割し、PDF を選んだときだけ読み込む（初期バンドルを軽く保つ）。
 *
 * 失敗時は「どの段階で落ちたか」が分かるメッセージで throw する（従来は全部まとめて
 * 「下絵の読み込みに失敗しました」になり、原因の切り分けができなかった）。
 *
 * @param scale 希望する描画スケール。大きすぎる場合は上限内へ自動で切り下げる。
 */
export async function pdfPageToDataUrl(file: File, pageNumber = 1, scale = 2): Promise<PdfRasterResult> {
  let pdfjs: PdfjsModule;
  try {
    pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  } catch (e) {
    throw new UnderlayError(`PDF描画エンジンを読み込めませんでした: ${(e as Error)?.message ?? e}`);
  }

  const data = new Uint8Array(await file.arrayBuffer());
  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    pdf = await pdfjs.getDocument({ data }).promise;
  } catch (e) {
    // 暗号化・破損・非PDF などはここに来る（pdfjs が名前付き例外を投げる）。
    const name = (e as Error)?.name ?? '';
    if (name === 'PasswordException') throw new UnderlayError('パスワード保護されたPDFは読み込めません。');
    if (name === 'InvalidPDFException') throw new UnderlayError('PDFファイルが壊れているため読み込めません。');
    throw new UnderlayError(`PDFを開けませんでした: ${(e as Error)?.message ?? e}`);
  }

  try {
    // 範囲外のページ番号は実在ページへ丸める（利用者の指定ミスでエラーにしない）。
    const pageCount = pdf.numPages;
    const targetPage = clampPageNumber(pageNumber, pageCount);
    const page = await pdf.getPage(targetPage);
    const base = page.getViewport({ scale: 1 });
    const usedScale = fitRasterScale(base.width, base.height, scale);
    const viewport = page.getViewport({ scale: usedScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new UnderlayError('画像化用のキャンバスを準備できませんでした。');
    try {
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      throw new UnderlayError(`PDFの描画に失敗しました（${canvas.width}×${canvas.height}px）: ${(e as Error)?.message ?? e}`);
    }
    const dataUrl = canvas.toDataURL('image/png');
    // メモリ不足時、ブラウザは例外ではなく 'data:,' を返すことがある。無言で成功扱いにしない。
    if (!dataUrl || dataUrl.length < 32) {
      throw new UnderlayError(`PDFの画像化に失敗しました（${canvas.width}×${canvas.height}px・メモリ不足の可能性）。`);
    }
    return { dataUrl, usedScale, pageCount };
  } finally {
    // cleanup 自体が投げると finally の例外が本来の診断メッセージを握り潰す。
    // 描画中断時 pdfjs は「Page N is currently rendering.」を投げるため、まさに失敗を伝えたい場面で
    // 原因が英語の内部エラーにすり替わってしまう（260728 敵対レビュー指摘）。必ず握りつぶす。
    try {
      await pdf.cleanup();
    } catch {
      /* 診断メッセージを潰さない */
    }
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
  /** PDF の総ページ数。2以上なら取り込むページを選ばせる（260805 クライアント要望）。 */
  pageCount: number;
}

/**
 * PDFの指定ページをラスタライズし、下絵の実寸合わせに必要な paperMmPerPx（用紙mm/px）も返す。
 * これに図面の縮尺(1:denom)を掛ければ実寸 scaleMmPerPx が求まり、用紙サイズ＋縮尺で下絵を正しいサイズにできる。
 *
 * 【260805 クライアント要望】複数ページのPDFでは何枚目を取り込むか選べるようにするため、
 * ページ番号を受け取る。ページごとに用紙サイズが違うPDFもあるので、paperMmPerPx は
 * 選んだページから毎回求め直すこと（1ページ目の値を使い回すと実寸がずれる）。
 */
export async function pdfPageToUnderlay(file: File, pageNumber = 1, scale = 2): Promise<PdfPageRaster> {
  // 実際に使われたスケールで mm/px を出す。上限で切り下げられた場合に希望スケールで割ると
  // 用紙実寸がズレる（＝縮尺合わせが狂う）ので、必ず usedScale を使う。
  const { dataUrl, usedScale, pageCount } = await pdfPageToDataUrl(file, pageNumber, scale);
  return { dataUrl, paperMmPerPx: MM_PER_PT / usedScale, pageCount };
}
