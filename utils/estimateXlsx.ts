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

/** 見積表の列定義（全区分で共通・列がずれない唯一の理由）。 */
const COLUMNS = [
  { header: 'No.', key: 'no', width: 6 },
  { header: '明細名称', key: 'name', width: 34 },
  { header: '仕様', key: 'spec', width: 22 },
  { header: '数量', key: 'qty', width: 10 },
  { header: '単位', key: 'unit', width: 7 },
  { header: '単価', key: 'unitPrice', width: 13 },
  { header: '金額', key: 'amount', width: 14 },
  { header: '備考', key: 'remark', width: 46 },
] as const;

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
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    });
    // PDF の画像ページと同じく、上にプロジェクト名と日付を置く。
    is.getColumn(1).width = 120;
    const t = is.addRow([payload.projectName || 'プロジェクト名']);
    t.font = { bold: true, size: 14 };
    is.addRow([`日付：${dateLabel}`]).font = { size: 10, color: { argb: 'FF666666' } };
    is.addRow([]);

    const natural = await imageSize(heroUrl);
    const MAX_W = 900;
    const ratio = natural && natural.h > 0 ? natural.w / natural.h : 16 / 9;
    const h = Math.round(MAX_W / ratio);
    const imgRow = is.addRow([]);
    // Excel の行高は最大 409pt。縦長画像で超えると Excel が開くときに警告を出す。
    imgRow.height = Math.min(409, h * 0.75 + 6);
    const heroId = wb.addImage({ base64: heroImg.base64, extension: heroImg.extension });
    is.addImage(heroId, {
      tl: { col: 0.1, row: imgRow.number - 1 + 0.1 },
      ext: { width: MAX_W, height: h },
      editAs: 'oneCell',
    });
  }

  // ------------------------------------------------------------- シート2: 概算見積
  const ws = wb.addWorksheet('概算見積', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
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
    r.eachCell((cell, col) => {
      cell.border = BORDER;
      cell.alignment = { vertical: 'middle', horizontal: isNumericCol(col) ? 'right' : 'left' };
    });
    r.getCell(4).numFmt = QTY_FORMAT;
    r.getCell(6).numFmt = YEN_FORMAT;
    r.getCell(7).numFmt = YEN_FORMAT;
    // 備考は長くなるので折り返す（列外へはみ出させない）。
    r.getCell(8).alignment = { wrapText: true, vertical: 'middle', horizontal: 'left' };
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
    const r = ws.addRow(['', '', '', '', '', label, value, '']);
    r.font = { bold: true, size: 9 };
    r.eachCell((cell) => {
      cell.border = BORDER;
    });
    r.getCell(6).alignment = { horizontal: 'right', vertical: 'middle' };
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

  const totalRow = ws.addRow(['', '', '', '', '', '税込合計', payload.grandTotal, '']);
  totalRow.font = { bold: true, size: 11 };
  totalRow.eachCell((cell) => {
    cell.border = { ...BORDER, top: { style: 'double', color: { argb: 'FF111111' } } };
  });
  totalRow.getCell(6).alignment = { horizontal: 'right', vertical: 'middle' };
  totalRow.getCell(7).numFmt = YEN_FORMAT;
  totalRow.getCell(7).alignment = { horizontal: 'right', vertical: 'middle' };

  ws.addRow([]);
  addBannerRow('※建材はロス率込みの数量です。', { size: 8, color: 'FF777777' });

  // -------------------------------------------------- シート3: マテリアルボード
  if (payload.materialBoard.length > 0) {
    const bs = wb.addWorksheet('マテリアルボード', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    bs.columns = [
      { key: 'img', width: 22 },
      { key: 'part', width: 26 },
      { key: 'name', width: 34 },
      { key: 'brand', width: 22 },
      { key: 'usage', width: 30 },
    ];
    const bTitle = bs.addRow([payload.projectName || 'マテリアルボード']);
    bTitle.font = { bold: true, size: 14 };
    bs.mergeCells(bTitle.number, 1, bTitle.number, 5);
    bs.addRow([`日付：${dateLabel}`]).font = { size: 9, color: { argb: 'FF666666' } };
    bs.addRow([]);

    const bh = bs.addRow(['画像', '品番', '表示名', 'メーカー', '使用箇所']);
    bh.font = { bold: true, size: 9 };
    bh.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
      cell.border = BORDER;
      cell.alignment = { vertical: 'middle' };
    });

    // 画像セルの基準サイズ（px）。行の高さはポイント指定なので約 0.75 を掛ける。
    const CELL_IMG_W = 140;
    const CELL_IMG_H = 105;

    for (const b of payload.materialBoard) {
      const row = bs.addRow([
        '',
        formatPartCodeForDisplay(b.modelNumber, b.partCode),
        b.displayName,
        b.brand,
        b.usages.join(' / '),
      ]);
      row.height = CELL_IMG_H * 0.75 + 6;
      row.font = { size: 9 };
      row.alignment = { vertical: 'middle', wrapText: true };
      row.eachCell((cell) => {
        cell.border = BORDER;
      });

      const swatch = await toImagePayload(b.textureUrl);
      if (!swatch) continue; // 取得できない画像は空欄のまま（行と文字情報は残す）
      const natural = await imageSize(b.textureUrl);
      // 縦横比を保ったままセルへ収める。
      const ratio = natural && natural.h > 0 ? natural.w / natural.h : 1;
      const wide = ratio >= CELL_IMG_W / CELL_IMG_H;
      const w = wide ? CELL_IMG_W : CELL_IMG_H * ratio;
      const h = wide ? CELL_IMG_W / ratio : CELL_IMG_H;
      const id = wb.addImage({ base64: swatch.base64, extension: swatch.extension });
      bs.addImage(id, {
        tl: { col: 0.1, row: row.number - 1 + 0.1 },
        ext: { width: w, height: h },
        editAs: 'oneCell',
      });
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerBlobDownload(blob, estimateExportFilename('xlsx'));
}
