import type { EstimateExportPayload, SurfaceKey } from './estimateExport.js';
import { estimateExportFilename, formatPartCodeForDisplay } from './estimateExport.js';

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
 * 【シート構成】
 *  1. 概算見積     … 全区分を同じ8列の表に統一（家具/AIも同じ列に載せる）。区分ごとに小計、最後に総合計。
 *  2. マテリアルボード … 1行1スワッチ。テクスチャ画像をセルに埋め込む。
 *  3. AI画像       … AI生成画像がある場合のみ。PDFの画像ページに相当。
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

  // ---------------------------------------------------------------- 概算見積
  const ws = wb.addWorksheet('概算見積', {
    views: [{ state: 'frozen', ySplit: 0 }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  const dateLabel = new Date(payload.generatedAtIso).toLocaleString('ja-JP');
  const titleRow = ws.addRow(['概算見積もり']);
  titleRow.font = { bold: true, size: 16 };
  ws.addRow([payload.projectName || '']).font = { bold: true, size: 12 };
  ws.addRow([`作成者：${payload.authorName || '—'}`]);
  ws.addRow([`出力日時：${dateLabel}`]);
  ws.addRow([]);

  /** 見出し行（区分名）。 */
  const addSectionHeader = (title: string) => {
    const r = ws.addRow([title]);
    r.font = { bold: true, size: 12 };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    ws.mergeCells(r.number, 1, r.number, COLUMNS.length);
  };

  /** 列見出し行。 */
  const addColumnHeader = () => {
    const r = ws.addRow(COLUMNS.map((c) => c.header));
    r.font = { bold: true };
    r.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
      cell.alignment = { vertical: 'middle' };
    });
  };

  /** 明細1行。数値セルには書式を当て、備考は折り返す。 */
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
    r.getCell(4).numFmt = QTY_FORMAT;
    r.getCell(6).numFmt = YEN_FORMAT;
    r.getCell(7).numFmt = YEN_FORMAT;
    /*
      順序が重要。exceljs の Row.alignment はその値を行内の全セルへ複製するため、
      先にセル単位で wrapText を付けても行単位の指定で上書きされて消える。
      行 → セルの順で当てること（逆にすると備考が折り返されず、列外へはみ出す）。
    */
    r.alignment = { vertical: 'top' };
    r.getCell(8).alignment = { wrapText: true, vertical: 'top' };
    return r;
  };

  /** 小計行（金額列に入れる＝区分をまたいで同じ列に揃う）。 */
  const addSubtotal = (label: string, value: number) => {
    const r = ws.addRow(['', '', '', '', '', label, value, '']);
    r.font = { bold: true };
    r.getCell(7).numFmt = YEN_FORMAT;
    r.getCell(7).border = { top: { style: 'thin', color: { argb: 'FF999999' } } };
    ws.addRow([]);
  };

  for (const sec of payload.materialSections) {
    addSectionHeader(`【${SECTION_TITLES[sec.key] ?? sec.title}】`);
    addColumnHeader();
    for (const r of sec.rows) {
      addDetailRow({
        no: r.no,
        name: r.detailName,
        spec: r.spec,
        qty: r.quantity,
        unit: r.unit,
        unitPrice: r.unitPrice,
        amount: r.amount,
        remark: r.remark,
      });
    }
    addSubtotal(`${sec.title} 小計`, sec.subtotal);
  }

  // 家具・AI追加も同じ8列へ載せる（CSVで列がずれていた原因を構造的に断つ）。
  // ブランドは「仕様」列、数量は「個」。
  if (payload.furniture.length > 0) {
    addSectionHeader('【家具リスト】');
    addColumnHeader();
    for (const r of payload.furniture) {
      addDetailRow({
        no: r.no,
        name: r.itemName,
        spec: r.brand,
        qty: r.quantity,
        unit: '個',
        unitPrice: r.unitPrice,
        amount: r.amount,
        remark: r.remark,
      });
    }
    addSubtotal('家具 小計', payload.furnitureTotal);
  }

  if (payload.aiItems.length > 0) {
    addSectionHeader('【AI追加アイテム】');
    addColumnHeader();
    for (const r of payload.aiItems) {
      addDetailRow({
        no: r.no,
        name: r.itemName,
        spec: r.brand,
        qty: r.quantity,
        unit: '個',
        unitPrice: r.unitPrice,
        amount: r.amount,
        remark: r.remark,
      });
    }
    addSubtotal('AI追加アイテム 小計', payload.aiItemsTotal);
  }

  const totalRow = ws.addRow(['', '', '', '', '', '税込合計', payload.grandTotal, '']);
  totalRow.font = { bold: true, size: 12 };
  totalRow.getCell(7).numFmt = YEN_FORMAT;
  totalRow.getCell(7).border = { top: { style: 'double', color: { argb: 'FF333333' } } };

  ws.addRow([]);
  ws.addRow(['※建材はロス率込みの数量です。']).font = { size: 9, color: { argb: 'FF777777' } };

  // -------------------------------------------------------- マテリアルボード
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
    const bh = bs.addRow(['画像', '品番', '表示名', 'メーカー', '使用箇所']);
    bh.font = { bold: true };
    bh.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
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
      row.alignment = { vertical: 'middle', wrapText: true };

      const payloadImg = await toImagePayload(b.textureUrl);
      if (!payloadImg) continue; // 取得できない画像は空欄のまま（行と文字情報は残す）
      const natural = await imageSize(b.textureUrl);
      // 縦横比を保ったままセルへ収める。
      const ratio = natural ? natural.w / natural.h : 1;
      const w = ratio >= CELL_IMG_W / CELL_IMG_H ? CELL_IMG_W : CELL_IMG_H * ratio;
      const h = ratio >= CELL_IMG_W / CELL_IMG_H ? CELL_IMG_W / ratio : CELL_IMG_H;
      const id = wb.addImage({ base64: payloadImg.base64, extension: payloadImg.extension });
      bs.addImage(id, {
        tl: { col: 0.1, row: row.number - 1 + 0.1 },
        ext: { width: w, height: h },
        editAs: 'oneCell',
      });
    }
  }

  // ------------------------------------------------------------------ AI画像
  if (payload.roomImageDataUrl) {
    const img = await toImagePayload(payload.roomImageDataUrl);
    if (img) {
      const is = wb.addWorksheet('AI画像', {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
      });
      is.getColumn(1).width = 120;
      const natural = await imageSize(payload.roomImageDataUrl);
      const MAX_W = 900;
      const ratio = natural ? natural.w / natural.h : 16 / 9;
      const w = MAX_W;
      const h = Math.round(MAX_W / ratio);
      // Excel の行高は最大 409pt。縦長画像だと超えるので丸める（超えると Excel が開くとき警告を出す）。
      is.getRow(1).height = Math.min(409, h * 0.75 + 6);
      const id = wb.addImage({ base64: img.base64, extension: img.extension });
      is.addImage(id, { tl: { col: 0.1, row: 0.1 }, ext: { width: w, height: h }, editAs: 'oneCell' });
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = estimateExportFilename('xlsx');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
