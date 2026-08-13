import type { PaperSize } from 'exceljs';
import type { EstimateExportPayload, SurfaceKey } from './estimateExport.js';
import { estimateExportFilename, formatPartCodeForDisplay, triggerBlobDownload } from './estimateExport.js';

/**
 * 概算見積の Excel（.xlsx）書き出し（260811 クライアント要望④）。
 *
 * 【なぜ CSV を置き換えるのか】
 * クライアントのご指摘は「CSVは書き出せるが表示が崩れる。PDFのように正確に出したい。画像も一緒に」。
 * 崩れの原因は文字コードではなく列数の不一致だった（建材8列・家具/AI7列・ボード4列を1枚に縦積み）。
 * ただし列を揃えても、CSVは列幅・書式・画像を保持できない形式なので「PDFのように」は原理的に達成できない。
 * そこで CSV を廃止し、xlsx へ差し替える。列幅・数値書式・画像埋め込みが保持でき、
 * さらに「メモの先頭が = だと Excel が数式として解釈する」CSV固有の危険も無くなる
 * （xlsx は文字列セルとして書くため）。
 *
 * 【シート構成】PDF のページ順に合わせる（260812 クライアント指摘「1ページ目の画像が3ページ目に出る」）。
 *  1. AI画像       … AI生成画像がある場合のみ。PDF の1ページ目に相当。
 *  2. 概算見積     … 全区分を同じ8列の表に統一（家具/AIも同じ列に載せる）。区分ごとに小計、最後に総合計。
 *  3. マテリアルボード … 1行1スワッチ。テクスチャ画像をセルに埋め込む。
 *
 * 【体裁】PDF と同じ見え方に揃える（260812）: 全セル罫線・列見出しは灰色地・数量〜金額は右寄せ・
 * 税込合計は本文先頭に大きく表示・表題と区分見出しは表幅いっぱいに結合（隣列へはみ出させない）。
 *
 * exceljs はサイズが大きい（ブラウザ版で約900KB）ため、必ず動的 import で読み込む
 * （書き出しボタンを押したときだけ取得され、初期表示のバンドルには含まれない）。
 */

/**
 * 見積表の列定義（全区分で共通・列がずれない唯一の理由）。
 *
 * 【幅の決め方（260813 クライアント指摘「ExcelからPDFにすると表が小さくなる」）】
 * OOXML の col@width は「既定スタイルのフォントで 0 が何文字入るか」で、
 * **5px のパディングを既に含んだ値**。したがって px = 幅 × 7（既定 Calibri 11 の
 * 最大数字幅が 7px。既定幅 9.140625 × 7 = 64px と一致する）。「×7+5」ではない。
 *
 * A4縦・余白10mm の印刷可能幅は 189.7mm ≒ 717px。合計がこれを超えると
 * Excel が「1ページ幅に収める」設定に従ってページ全体を縮小し、文字が潰れる。
 * 旧値（合計152 = 1064px = 281mm）は余白0.7in の印刷可能幅174mm に対して
 * 約61%まで潰れていた（Excel出力PDFの実測値と一致）。
 *
 * 合計98 = 686px = 181.5mm。Arise のPDFの表（実インク幅 約174.6mm）に近く、
 * かつ印刷可能幅に収まるので縮小されない。
 */
const COLUMNS = [
  { header: 'No.', key: 'no', width: 5 },
  // 「Sangetsu KAGETOHIKARI_R KAG111C_R01」級（半角35文字）が1行に収まる幅。
  { header: '明細名称', key: 'name', width: 26 },
  /*
    仕様は全行に固定文字列が入る（estimateExport.ts の 'ロス率込み・㎡単価'＝全角9文字、
    巾木は '壁延長・m単価'＝全角7文字）。9pt の全角は約12px なので約108px 必要。
    隣の数量セルには必ず値があるため、幅が足りないと**はみ出し表示にならず切り捨てられる**。
  */
  { header: '仕様', key: 'spec', width: 16 },
  // 数量は '#,##0.###' なので「1,234.567」の9文字が入る幅が要る（不足すると ##### 表示になる）。
  { header: '数量', key: 'qty', width: 10 },
  { header: '単位', key: 'unit', width: 5 },
  // 単価「1,234,567」9文字 / 金額「123,456,789」11文字まで。
  { header: '単価', key: 'unitPrice', width: 11 },
  { header: '金額', key: 'amount', width: 12 },
  { header: '備考', key: 'remark', width: 13 },
] as const;

/** 見積表の列幅（テスト用・用紙に収まっているかを数値で担保する）。 */
export const ESTIMATE_COLUMN_WIDTHS: readonly number[] = COLUMNS.map((c) => c.width);

/**
 * マテリアルボードは PDF と同じ「横4枚×縦2段＝1ページ8枚」のカード並び
 * （260813 クライアント指摘「PDFと見た目が別物・素材画像の大きさがバラバラ」）。
 *
 * 1列＝カード1枚。53単位 = 371px = 98.1mm で、PDF のカード幅（1188px中283px ≒ 100mm）とほぼ同じ。
 * 4列で 1484px = 392.6mm。A3横・余白10mm の印刷可能幅 399.7mm に収まるので縮小されない。
 */
export const BOARD_CARD_COLS = 4;
export const BOARD_CARD_COL_WIDTH = 53;
/** 1ページに入れるカードの段数（4枚×2段＝8枚。PDF の PER_PAGE と一致）。 */
export const BOARD_ROWS_PER_PAGE = 2;
/** ヘッダ／フッタ帯の色（PDF の #3a3a3a）。 */
const BOARD_BAND_BG = 'FF3A3A3A';

/** テスト用: カード列の合計幅（px）。 */
export const BOARD_COLUMN_WIDTHS: readonly number[] = Array.from(
  { length: BOARD_CARD_COLS },
  () => BOARD_CARD_COL_WIDTH,
);

/**
 * 印刷余白（インチ）。Arise のPDF（余白10mm）に合わせる。
 * Excel の既定は左右19mm と広く、そのぶん表がさらに縮小されてしまう。
 */
const PRINT_MARGINS = {
  left: 0.4,
  right: 0.4,
  top: 0.4,
  bottom: 0.4,
  header: 0.2,
  footer: 0.2,
} as const;

/**
 * A3（OOXML の paperSize=8）。exceljs の PaperSize 列挙は A3 を持っていないため
 * 型を通すためにキャストする。値そのものは OOXML 標準で Excel は正しく解釈する。
 * Arise のPDFは 画像＝A3横 / 見積本文＝A4縦 / マテリアルボード＝A3横 なので、
 * Excel のシートも同じ用紙・向きに揃える（260813 クライアント指摘）。
 */
const PAPER_A3 = 8 as unknown as PaperSize;
const PAPER_A4 = 9 as unknown as PaperSize;

/**
 * シートごとの印刷設定。Arise のPDFのページと1対1で対応させる。
 *
 * ここが今回の崩れの真因だった。用紙サイズを書かないと Excel は出力先の既定用紙を使い、
 * 横向きのシートは内容ごと90度回転して縦の用紙に押し込まれる（実際そうなっていた）。
 * 直接テストできるよう、addWorksheet から切り出して純関数にしている。
 */
export type SheetKind = 'image' | 'estimate' | 'board';

export function pageSetupFor(kind: SheetKind) {
  const margins = { ...PRINT_MARGINS };
  if (kind === 'estimate') {
    // PDF の見積本文ページと同じ A4縦。縦は内容なりに複数ページ（fitToHeight: 0）。
    return { paperSize: PAPER_A4, orientation: 'portrait' as const, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins };
  }
  // PDF の画像ページ／マテリアルボードページと同じ A3横。
  // 画像は1ページに収める（fitToHeight: 1）、ボードは材料数なりに増やす（0）。
  return {
    paperSize: PAPER_A3,
    orientation: 'landscape' as const,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: kind === 'image' ? 1 : 0,
    margins,
  };
}

/** 印刷可能領域（px・96dpi）。A3横＝420×297mm、余白は上下左右10mm。 */
const A3_LAND_W = Math.round(((420 - 20) / 25.4) * 96); // ≒1512
const A3_LAND_H = Math.round(((297 - 20) / 25.4) * 96); // ≒1047

/**
 * 画像ページに置ける最大の大きさ（px）。A3横の印刷可能領域から
 * 見出し（プロジェクト名・日付・空行）のぶんを引いた実寸。
 */
const IMAGE_BOX_W = A3_LAND_W - 60;
const IMAGE_BOX_H = A3_LAND_H - 90;

/** 縦横比を保ったまま (boxW × boxH) に収まる寸法（純関数・テスト用）。 */
export function fitImageBox(ratio: number, boxW = IMAGE_BOX_W, boxH = IMAGE_BOX_H): { w: number; h: number } {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
  let w = boxW;
  let h = Math.round(boxW / r);
  if (h > boxH) {
    h = boxH;
    w = Math.round(boxH * r);
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, h) };
}

/**
 * px 幅 → Excel の列幅単位（px = 幅×7 の逆算）。
 * 切り上げること。切り捨て/四捨五入で列が画像より 1px でも狭くなると、
 * 画像が隣の列へはみ出して印刷範囲が1列ぶん広がり、fitToPage が余計に縮小する。
 */
export function pxToColWidth(px: number): number {
  const v = Number.isFinite(px) ? px : 0;
  // Excel の列幅上限は 255。
  return Math.max(1, Math.min(255, Math.ceil(v / 7)));
}

/**
 * 画像の高さを複数行へ割り振る（Excel の行高上限は 409pt）。
 * 1行に押し込むと上限で頭打ちになり、印刷範囲が画像より短くなって
 * 「1ページに収める」設定でページ全体が縮小されてしまう。
 */
export function splitRowHeights(imageHeightPx: number, maxPt = 400): number[] {
  const totalPt = (Number.isFinite(imageHeightPx) && imageHeightPx > 0 ? imageHeightPx : 1) * 0.75 + 6;
  const rows = Math.max(1, Math.ceil(totalPt / maxPt));
  return Array.from({ length: rows }, () => totalPt / rows);
}

const SECTION_TITLES: Record<SurfaceKey, string> = {
  floor: '床',
  ceiling: '天井',
  wall: '壁',
  beam: '梁',
  baseboard: '巾木',
};

/** 円の表示形式（3桁区切り・小数なし）。 */
const YEN_FORMAT = '#,##0';
/** 数量は小数3位まで（m² / m）。 */
const QTY_FORMAT = '#,##0.###';

/**
 * スワッチ寸法（px）。全材料を必ずこの寸法で並べる（＝大きさが揃う）。
 * カード列は53単位＝371px なので、枠線ぶんを残して 366px。
 * 高さは PDF のカード（283x264px）と同じ比率 1.072 に合わせる。
 * 行高 = 341×0.75 ≒ 256pt。見出し16 + 256 + キャプション28 + すき間10 = 310pt/段。
 * A3横の印刷可能高さ785pt に対し、帯を除いて2段（＝8枚）入る。
 */
export const SWATCH_W = 366;
export const SWATCH_H = 341;

/** 縦横比を保ったまま枠を埋める中央切り抜きの矩形（純関数・テスト用）。 */
export function coverCropRect(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const w = Number.isFinite(srcW) && srcW > 0 ? srcW : 1;
  const h = Number.isFinite(srcH) && srcH > 0 ? srcH : 1;
  const target = boxW / boxH;
  const src = w / h;
  // 元が枠より横長なら左右を、縦長なら上下を捨てる。
  const sw = src > target ? h * target : w;
  const sh = src > target ? h : w / target;
  return {
    sx: Math.max(0, (w - sw) / 2),
    sy: Math.max(0, (h - sh) / 2),
    sw: Math.min(w, sw),
    sh: Math.min(h, sh),
  };
}

/**
 * 画像を boxW×boxH ちょうどの大きさへ中央切り抜きして base64 化する（CSS の object-fit: cover 相当）。
 * 取得・描画に失敗したら null（呼び出し側で元画像へフォールバックする）。
 */
function coverCropToBase64(
  url: string,
  boxW: number,
  boxH: number,
): Promise<{ base64: string; extension: 'png' | 'jpeg' | 'gif' } | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = boxW;
        c.height = boxH;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        const { sx, sy, sw, sh } = coverCropRect(img.naturalWidth, img.naturalHeight, boxW, boxH);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, boxW, boxH);
        const dataUrl = c.toDataURL('image/png');
        const idx = dataUrl.indexOf(',');
        resolve(idx >= 0 ? { base64: dataUrl.slice(idx + 1), extension: 'png' } : null);
      } catch {
        // 別オリジンの画像で canvas が汚染された場合など。
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Excel が扱えない形式（WebP 等）を PNG の base64 へ変換する。失敗したら null。 */
function reencodeToPngBase64(objectUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1;
        c.height = img.naturalHeight || 1;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const dataUrl = c.toDataURL('image/png');
        const idx = dataUrl.indexOf(',');
        resolve(idx >= 0 ? dataUrl.slice(idx + 1) : null);
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    img.src = objectUrl;
  });
}

/** 画像を base64 と拡張子へ。取得できなければ null（行は残す＝画像だけ諦める）。 */
async function toImagePayload(
  url: string,
): Promise<{ base64: string; extension: 'png' | 'jpeg' | 'gif' } | null> {
  if (!url) return null;
  try {
    // data: URL はネットワークへ行かずそのまま使う（ゲスト環境ではテクスチャが data URI になる）。
    const m = /^data:image\/(png|jpe?g|gif);base64,(.+)$/i.exec(url);
    if (m) {
      const ext = m[1].toLowerCase();
      return { base64: m[2], extension: ext === 'jpg' ? 'jpeg' : (ext as 'png' | 'jpeg' | 'gif') };
    }
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const type = (blob.type || '').toLowerCase();
    /*
      xlsx が扱える画像は png / jpeg / gif の3種類だけ。
      アップロードしたテクスチャは容量削減のため WebP へ再エンコードされることがあり
      （utils/downsizeImageFile.ts）、そのまま jpeg として入れると Excel が画像を表示できない。
      対応外の形式は canvas を通して PNG へ変換してから埋め込む。
    */
    if (!type.includes('png') && !type.includes('gif') && !type.includes('jpeg') && !type.includes('jpg')) {
      const png = await reencodeToPngBase64(URL.createObjectURL(blob));
      return png ? { base64: png, extension: 'png' } : null;
    }
    const extension: 'png' | 'jpeg' | 'gif' = type.includes('png')
      ? 'png'
      : type.includes('gif')
        ? 'gif'
        : 'jpeg';
    const base64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = typeof fr.result === 'string' ? fr.result : '';
        const idx = s.indexOf(',');
        resolve(idx >= 0 ? s.slice(idx + 1) : '');
      };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    return base64 ? { base64, extension } : null;
  } catch {
    // CORS 拒否・404・オフライン。画像なしで書き出しを続ける（書き出し自体を失敗させない）。
    return null;
  }
}

/** 画像の実寸を取る（セルの縦横比を合わせるため）。取れなければ null。 */
function imageSize(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function downloadEstimateXlsx(payload: EstimateExportPayload): Promise<void> {
  const mod = await import('exceljs');
  // UMD/ESM どちらで解決されても動くようにする（ブラウザ版は default に載る）。
  const ExcelJS: typeof import('exceljs') = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod;

  const wb = new ExcelJS.Workbook();
  wb.creator = payload.authorName || 'Arise';
  wb.created = new Date(payload.generatedAtIso);

  const dateLabel = new Date(payload.generatedAtIso).toLocaleString('ja-JP');
  const COLS = COLUMNS.length;

  /** PDFの表と同じ罫線（全セル1px）。 */
  const BORDER = {
    top: { style: 'thin' as const, color: { argb: 'FF333333' } },
    left: { style: 'thin' as const, color: { argb: 'FF333333' } },
    bottom: { style: 'thin' as const, color: { argb: 'FF333333' } },
    right: { style: 'thin' as const, color: { argb: 'FF333333' } },
  };
  /** 数量〜金額の列（PDFと同じく右寄せにする範囲）。 */
  const isNumericCol = (col: number) => col >= 4 && col <= 7;

  /*
    ---------------------------------------------------------------- シート1: AI画像

    【260812 クライアント指摘】PDFでは1ページ目が画像なのに、Excelでは3枚目のシートに出ていた。
    Excel の「シート」は PDF の「ページ」に相当するため、PDF と同じ順序
    （画像 → 見積本文 → マテリアルボード）でシートを追加する。
    画像の取得は非同期なので、先に取得を済ませてからシートを作る（順序を崩さないため）。
  */
  const heroUrl = payload.roomImageDataUrl;
  const heroImg = heroUrl ? await toImagePayload(heroUrl) : null;
  if (heroImg && heroUrl) {
    const is = wb.addWorksheet('AI画像', {
      pageSetup: pageSetupFor('image'),
    });
    /*
      【260813 クライアント指摘】画像ページだけ極端に小さく刷られていた。
      原因は幅だけを 900px に固定し、高さを縦横比なりに伸ばしていたこと。
      縦長画像だと高さが1,200px超になり、印刷可能領域（A4横で約718px）を大きく越える。
      fitToHeight:1（1ページに収める）が効いてページ全体が縮小され、
      見出しも画像も小さくなっていた。幅と高さの両方を用紙内に収める。
    */
    const natural = await imageSize(heroUrl);
    const ratio = natural && natural.h > 0 ? natural.w / natural.h : 16 / 9;
    const { w, h } = fitImageBox(ratio);

    // PDF の画像ページと同じく、上にプロジェクト名と日付を置く。
    // 列幅は画像の幅に合わせる（広すぎると空白ぶんまで1ページに収めようとして縮む）。
    is.getColumn(1).width = pxToColWidth(w);
    const t = is.addRow([payload.projectName || 'プロジェクト名']);
    t.font = { bold: true, size: 14 };
    is.addRow([`日付：${dateLabel}`]).font = { size: 10, color: { argb: 'FF666666' } };
    is.addRow([]);

    // 行高はポイント（1px = 0.75pt）で上限 409pt。画像の高さを複数行へ割り振る。
    const heights = splitRowHeights(h);
    const firstImgRow = is.addRow([]);
    firstImgRow.height = heights[0]!;
    for (const ht of heights.slice(1)) is.addRow([]).height = ht;
    const heroId = wb.addImage({ base64: heroImg.base64, extension: heroImg.extension });
    is.addImage(heroId, {
      /*
        アンカーに小数を使わないこと。exceljs は小数部を EMU へ物理換算せず、
        行高382.5pt のとき rowOff=382500EMU(≒30pt) のような値を書く。
        画像が行の内側で約8%下へずれ、下端が行からあふれて次の行・隣の列まで
        印刷範囲に入り、fitToPage が余計にページを縮小する原因になる。
      */
      tl: { col: 0, row: firstImgRow.number - 1 },
      ext: { width: w, height: h },
      editAs: 'oneCell',
    });
  }

  // ------------------------------------------------------------- シート2: 概算見積
  const ws = wb.addWorksheet('概算見積', {
    pageSetup: pageSetupFor('estimate'),
  });
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  /** 表題ブロック。表の幅いっぱいに結合し、隣の列へ文字がはみ出さないようにする。 */
  const addBannerRow = (text: string, opts: { size?: number; bold?: boolean; color?: string } = {}) => {
    const r = ws.addRow([text]);
    r.font = {
      bold: opts.bold ?? false,
      size: opts.size ?? 11,
      ...(opts.color ? { color: { argb: opts.color } } : {}),
    };
    ws.mergeCells(r.number, 1, r.number, COLS);
    return r;
  };

  addBannerRow('概算見積もり', { size: 16, bold: true });
  addBannerRow(`出力: ${dateLabel}`, { size: 9, color: 'FF666666' });
  if (payload.projectName) addBannerRow(payload.projectName, { size: 11, bold: true });
  if (payload.authorName) addBannerRow(`作成者: ${payload.authorName}`, { size: 9, color: 'FF666666' });
  ws.addRow([]);

  /*
    税込合計は PDF と同じく本文の先頭へ置く（PDF は太い下線付きの帯）。
    Excel では結合＋下罫線で同じ見え方にする。
  */
  addBannerRow('税込合計金額', { size: 9, color: 'FF555555' });
  const totalValueRow = ws.addRow([payload.grandTotal]);
  ws.mergeCells(totalValueRow.number, 1, totalValueRow.number, COLS);
  totalValueRow.font = { bold: true, size: 20 };
  totalValueRow.height = 28;
  totalValueRow.getCell(1).numFmt = '"¥"#,##0';
  totalValueRow.getCell(1).alignment = { vertical: 'middle' };
  totalValueRow.getCell(1).border = { bottom: { style: 'medium', color: { argb: 'FF111111' } } };
  ws.addRow([]);

  /** 区分見出し（PDF の「【床】」等。下線付き）。 */
  const addSectionHeader = (title: string) => {
    const r = ws.addRow([title]);
    r.font = { bold: true, size: 11 };
    ws.mergeCells(r.number, 1, r.number, COLS);
    r.getCell(1).border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
  };

  /** 列見出し（PDF の thead と同じく灰色地・罫線・太字）。 */
  const addColumnHeader = () => {
    const r = ws.addRow(COLUMNS.map((c) => c.header));
    r.font = { bold: true, size: 9 };
    r.eachCell((cell, col) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
      cell.border = BORDER;
      cell.alignment = { vertical: 'middle', horizontal: isNumericCol(col) ? 'right' : 'left' };
    });
  };

  /** 明細1行。PDF と同じく全セルに罫線、数値は右寄せ。 */
  const addDetailRow = (cells: {
    no: number;
    name: string;
    spec: string;
    qty: number;
    unit: string;
    unitPrice: number;
    amount: number;
    remark: string;
  }) => {
    const r = ws.addRow([
      cells.no,
      cells.name,
      cells.spec,
      cells.qty,
      cells.unit,
      cells.unitPrice,
      cells.amount,
      cells.remark,
    ]);
    r.font = { size: 9 };
    /*
      順序が重要。exceljs の Row.alignment は指定値を行内の全セルへ複製するため、
      行 → セルの順で当てること（逆にするとセル側の折り返し指定が消える）。
    */
    r.alignment = { vertical: 'middle' };
    /*
      文字列の列（明細名称・仕様・備考）は折り返す。
      隣のセルに値があると Excel ははみ出し表示をせず**文字を切り捨てる**ため、
      折り返しを付けないと列幅を超えたぶんが読めなくなる（行高は自動で伸びる）。
    */
    const WRAP_COLS = new Set([2, 3, 8]);
    r.eachCell((cell, col) => {
      cell.border = BORDER;
      cell.alignment = {
        vertical: 'middle',
        horizontal: isNumericCol(col) ? 'right' : 'left',
        ...(WRAP_COLS.has(col) ? { wrapText: true } : {}),
      };
    });
    r.getCell(4).numFmt = QTY_FORMAT;
    r.getCell(6).numFmt = YEN_FORMAT;
    r.getCell(7).numFmt = YEN_FORMAT;
  };

  /** 「（該当なし）」行（PDF と同じ体裁）。 */
  const addEmptyRow = (text: string) => {
    const r = ws.addRow([text]);
    ws.mergeCells(r.number, 1, r.number, COLS);
    r.font = { size: 9, italic: true, color: { argb: 'FF999999' } };
    r.getCell(1).border = BORDER;
  };

  /** 小計行。金額は必ず「金額」列へ入れ、区分をまたいで同じ列に揃える。 */
  const addSubtotal = (label: string, value: number) => {
    /*
      ラベルは1〜6列を結合した上に置く。単価列だけに入れると、
      「AI追加アイテム 小計」（9pt で約124px）が幅77px の列に収まらず、
      隣の金額セルに値があるためはみ出し表示にならず切り捨てられる。
      結合セルは左上（1列目）の値を表示するので、ラベルは1列目に入れること。
    */
    const r = ws.addRow([label, '', '', '', '', '', value, '']);
    r.font = { bold: true, size: 9 };
    r.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = BORDER;
    });
    ws.mergeCells(r.number, 1, r.number, 6);
    r.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
    r.getCell(7).numFmt = YEN_FORMAT;
    r.getCell(7).alignment = { horizontal: 'right', vertical: 'middle' };
    ws.addRow([]);
  };

  /** 1区分ぶんの表（見出し → 列見出し → 明細 → 小計）。 */
  const addSection = (
    title: string,
    rows: {
      no: number;
      name: string;
      spec: string;
      qty: number;
      unit: string;
      unitPrice: number;
      amount: number;
      remark: string;
    }[],
    subtotalLabel: string,
    subtotal: number,
    emptyText: string,
  ) => {
    addSectionHeader(title);
    addColumnHeader();
    if (rows.length === 0) addEmptyRow(emptyText);
    for (const row of rows) addDetailRow(row);
    addSubtotal(subtotalLabel, subtotal);
  };

  for (const sec of payload.materialSections) {
    addSection(
      `【${SECTION_TITLES[sec.key] ?? sec.title}】`,
      sec.rows.map((r) => ({
        no: r.no,
        name: r.detailName,
        spec: r.spec,
        qty: r.quantity,
        unit: r.unit,
        unitPrice: r.unitPrice,
        amount: r.amount,
        remark: r.remark,
      })),
      `${sec.title} 小計`,
      sec.subtotal,
      '（該当なし）',
    );
  }

  // 家具・AI追加も同じ8列へ載せる（列がずれない＝Excelで崩れて見える原因を断つ）。
  // ブランドは「仕様」列、単位は「個」。
  addSection(
    '【家具】',
    payload.furniture.map((r) => ({
      no: r.no,
      name: r.itemName,
      spec: r.brand,
      qty: r.quantity,
      unit: '個',
      unitPrice: r.unitPrice,
      amount: r.amount,
      remark: r.remark,
    })),
    '家具 小計',
    payload.furnitureTotal,
    '（家具なし）',
  );

  addSection(
    '【AI追加アイテム】',
    payload.aiItems.map((r) => ({
      no: r.no,
      name: r.itemName,
      spec: r.brand,
      qty: r.quantity,
      unit: '個',
      unitPrice: r.unitPrice,
      amount: r.amount,
      remark: r.remark,
    })),
    'AI追加アイテム 小計',
    payload.aiItemsTotal,
    '（AI追加アイテムなし）',
  );

  // 小計行と同じ理由でラベルは1〜6列を結合した上へ置く（1列目が結合セルの表示値）。
  const totalRow = ws.addRow(['税込合計', '', '', '', '', '', payload.grandTotal, '']);
  totalRow.font = { bold: true, size: 11 };
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { ...BORDER, top: { style: 'double', color: { argb: 'FF111111' } } };
  });
  ws.mergeCells(totalRow.number, 1, totalRow.number, 6);
  totalRow.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
  totalRow.getCell(7).numFmt = YEN_FORMAT;
  totalRow.getCell(7).alignment = { horizontal: 'right', vertical: 'middle' };

  ws.addRow([]);
  addBannerRow('※建材はロス率込みの数量です。', { size: 8, color: 'FF777777' });

  // -------------------------------------------------- シート3: マテリアルボード
  if (payload.materialBoard.length > 0) {
    const bs = wb.addWorksheet('マテリアルボード', {
      pageSetup: pageSetupFor('board'),
    });
    /*
      【260813 クライアント指摘】PDF は横4枚のカード並びなのに Excel は1行1材料の表で、
      見た目がまったく別物だった。素材画像の大きさもバラバラだった。
      PDF（buildMaterialBoardPage）と同じ「横4枚×縦2段＝1ページ8枚」のカード構成にする。
        ・濃色の帯（プロジェクト名／日付）
        ・面の見出し（■床）はその面の初出カードにだけ出す
        ・スワッチは全枚数とも同寸法（中央切り抜き＝PDF の object-fit: cover と同じ）
        ・キャプション帯（■床1：品番【メーカー】）
        ・濃色のフッタ帯（作成者名）
    */
    bs.columns = Array.from({ length: BOARD_CARD_COLS }, (_, i) => ({
      key: `card${i}`,
      width: BOARD_CARD_COL_WIDTH,
    }));

    /** 濃色帯（ヘッダ／フッタ）。 */
    const addBandRow = (
      cells: string[],
      opts: { height: number; size: number },
    ) => {
      const r = bs.addRow(cells);
      r.height = opts.height;
      for (let c = 1; c <= BOARD_CARD_COLS; c += 1) {
        const cell = r.getCell(c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BOARD_BAND_BG } };
        cell.font = { bold: true, size: opts.size, color: { argb: 'FFFFFFFF' } };
      }
      return r;
    };

    // ヘッダ帯: 左にプロジェクト名、右に日付（PDF と同じ）。
    const bandRow = addBandRow(
      [payload.projectName || 'プロジェクト名', '', `日付：${dateLabel}`, ''],
      { height: 22, size: 12 },
    );
    const half = Math.max(1, Math.floor(BOARD_CARD_COLS / 2));
    bs.mergeCells(bandRow.number, 1, bandRow.number, half);
    bs.mergeCells(bandRow.number, half + 1, bandRow.number, BOARD_CARD_COLS);
    bandRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    bandRow.getCell(half + 1).alignment = { horizontal: 'right', vertical: 'middle' };
    bs.addRow([]).height = 6;

    // 面ごとの通し番号（床1/床2/壁1…）。materialBoard は面順にソート済み（PDF と同じ規則）。
    const counters: Record<string, number> = {};
    const entries = payload.materialBoard.map((it) => {
      const n = (counters[it.surface] = (counters[it.surface] ?? 0) + 1);
      return { it, label: `${SECTION_TITLES[it.surface] ?? ''}${n}` };
    });

    // 面見出しは「その面の初出カード」にだけ出す（PDF と同じ）。
    const seenSurface = new Set<string>();
    const rowsPerPage = BOARD_ROWS_PER_PAGE;

    for (let start = 0, band = 0; start < entries.length; start += BOARD_CARD_COLS, band += 1) {
      const chunk = entries.slice(start, start + BOARD_CARD_COLS);

      // 1) 面見出しの行
      const catRow = bs.addRow(
        chunk.map(({ it }) => {
          if (seenSurface.has(it.surface)) return '';
          seenSurface.add(it.surface);
          return `■${SECTION_TITLES[it.surface] ?? ''}`;
        }),
      );
      catRow.height = 16;
      catRow.font = { bold: true, size: 11 };
      catRow.alignment = { vertical: 'bottom' };

      // 2) スワッチの行
      const imgRow = bs.addRow([]);
      imgRow.height = SWATCH_H * 0.75;
      for (let c = 1; c <= chunk.length; c += 1) {
        imgRow.getCell(c).border = BORDER;
      }

      // 3) キャプションの帯
      const capRow = bs.addRow(
        chunk.map(
          ({ it, label }) =>
            `■${label}：${formatPartCodeForDisplay(it.modelNumber, it.partCode)}【${it.brand || 'メーカー名'}】`,
        ),
      );
      capRow.height = 28;
      capRow.font = { bold: true, size: 9 };
      for (let c = 1; c <= chunk.length; c += 1) {
        const cell = capRow.getCell(c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
        cell.border = BORDER;
        cell.alignment = { vertical: 'middle', wrapText: true };
      }

      // 4) カード間のすき間
      bs.addRow([]).height = 10;

      // スワッチを貼る（全枚数とも同寸法・中央切り抜き）。
      for (let i = 0; i < chunk.length; i += 1) {
        const cropped = await coverCropToBase64(chunk[i]!.it.textureUrl, SWATCH_W, SWATCH_H);
        // 切り抜きに失敗したときは元画像で代替する（画像を失わない）。
        const swatch = cropped ?? (await toImagePayload(chunk[i]!.it.textureUrl));
        if (!swatch) continue; // 取得できない画像は枠だけ残す
        const id = wb.addImage({ base64: swatch.base64, extension: swatch.extension });
        bs.addImage(id, {
          // 小数アンカーを使わない理由は AI画像シート側のコメント参照。
          tl: { col: i, row: imgRow.number - 1 },
          ext: { width: SWATCH_W, height: SWATCH_H },
          editAs: 'oneCell',
        });
      }

      // PDF と同じく1ページ8枚（横4×縦2）で改ページする。
      const isLast = start + BOARD_CARD_COLS >= entries.length;
      if (!isLast && (band + 1) % rowsPerPage === 0) {
        bs.getRow(bs.rowCount).addPageBreak();
      }
    }

    // フッタ帯: 作成者名（PDF と同じ）。
    const footRow = addBandRow([payload.authorName || '—', '', '', ''], { height: 18, size: 10 });
    bs.mergeCells(footRow.number, 1, footRow.number, BOARD_CARD_COLS);
    footRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerBlobDownload(blob, estimateExportFilename('xlsx'));
}
