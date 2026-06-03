import * as html2canvasModule from 'html2canvas';
import { jsPDF } from 'jspdf';
import type { EstimateExportPayload, MaterialBoardItem } from './estimateExport.js';
import { estimateExportFilename, triggerBlobDownload } from './estimateExport.js';

type Html2CanvasOptions = Partial<import('html2canvas').Options>;
type Html2CanvasFn = (el: HTMLElement, o?: Html2CanvasOptions) => Promise<HTMLCanvasElement>;
const html2canvas = (html2canvasModule as unknown as { default: Html2CanvasFn }).default;

const FONT_STACK = '"Segoe UI","Meiryo","Yu Gothic UI","Yu Gothic","Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif';

const MATERIAL_BOARD_PAGE_SIZE = 6;

function formatYen(n: number): string {
  return `¥${n.toLocaleString('ja-JP')}`;
}

function thStyle(align: 'left' | 'right'): string {
  return `border:1px solid #333;padding:6px 8px;background:#f0f0f0;font-weight:700;vertical-align:middle;line-height:1.4;text-align:${align};`;
}

function tdStyle(align: 'left' | 'right', extra = ''): string {
  return `border:1px solid #333;padding:6px 8px;vertical-align:middle;line-height:1.4;text-align:${align};${extra}`;
}

function buildEstimatePage(payload: EstimateExportPayload): HTMLElement {
  const root = document.createElement('div');
  root.style.cssText = `box-sizing:border-box;width:720px;padding:18px 22px;background:#fff;color:#111;font-family:${FONT_STACK};font-size:10px;line-height:1.35;`;

  const title = document.createElement('div');
  title.textContent = '概算見積もり';
  title.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:2px;';
  root.appendChild(title);

  const sub = document.createElement('div');
  sub.textContent = `出力: ${new Date(payload.generatedAtIso).toLocaleString('ja-JP')}`;
  sub.style.cssText = 'font-size:8px;color:#666;margin-bottom:10px;';
  root.appendChild(sub);

  const totalBar = document.createElement('div');
  totalBar.style.cssText = 'margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #111;';
  const tl = document.createElement('div');
  tl.textContent = '税込合計金額';
  tl.style.cssText = 'font-size:9px;color:#555;margin-bottom:2px;';
  const tv = document.createElement('div');
  tv.textContent = formatYen(payload.grandTotal);
  tv.style.cssText = 'font-size:20px;font-weight:800;letter-spacing:0.03em;';
  totalBar.appendChild(tl);
  totalBar.appendChild(tv);
  root.appendChild(totalBar);

  const addTable = (sectionTitle: string, rows: typeof payload.materialSections[0]['rows'], subtotal: number) => {
    const titlePlain = sectionTitle.replace(/【|】/g, '');
    const h = document.createElement('div');
    h.textContent = sectionTitle;
    h.style.cssText = 'font-size:11px;font-weight:700;margin:10px 0 4px;border-bottom:1px solid #ccc;padding-bottom:2px;';
    root.appendChild(h);

    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;table-layout:fixed;font-size:9px;margin-bottom:4px;';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['No.', '明細', '数量', '単位', '単価', '金額', '区分', '入力状態'].forEach((text, idx) => {
      const th = document.createElement('th');
      th.textContent = text;
      th.style.cssText = thStyle(idx >= 2 && idx <= 5 ? 'right' : 'left');
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = '（該当なし）';
      td.style.cssText = tdStyle('left', 'color:#999;font-style:italic;');
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const r of rows) {
        const tr = document.createElement('tr');
        const cells = [
          String(r.no),
          r.detailName,
          String(r.quantity),
          r.unit,
          formatYen(r.unitPrice),
          formatYen(r.amount),
          r.sectionType,
          r.inputStatus
        ];
        cells.forEach((text, i) => {
          const td = document.createElement('td');
          td.textContent = text;
          td.style.cssText = tdStyle(i >= 2 && i <= 5 ? 'right' : 'left');
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
    }
    const trS = document.createElement('tr');
    const tdL = document.createElement('td');
    tdL.colSpan = 7;
    tdL.textContent = `${titlePlain} 小計`;
    tdL.style.cssText = tdStyle('right', 'font-weight:700;');
    trS.appendChild(tdL);
    const tdA = document.createElement('td');
    tdA.textContent = formatYen(subtotal);
    tdA.style.cssText = tdStyle('right', 'font-weight:700;');
    trS.appendChild(tdA);
    tbody.appendChild(trS);
    table.appendChild(tbody);
    root.appendChild(table);
  };

  for (const sec of payload.materialSections) {
    addTable(`【${sec.title}】`, sec.rows, sec.subtotal);
  }

  const fh = document.createElement('div');
  fh.textContent = '【家具】';
  fh.style.cssText = 'font-size:11px;font-weight:700;margin:10px 0 4px;border-bottom:1px solid #ccc;padding-bottom:2px;';
  root.appendChild(fh);

  const fTable = document.createElement('table');
  fTable.style.cssText = 'width:100%;border-collapse:collapse;table-layout:fixed;font-size:9px;';
  const ftHead = document.createElement('thead');
  const fhr = document.createElement('tr');
  ['No.', '品名', 'ブランド', '数量', '単価', '金額', '区分', '入力状態'].forEach((text, idx) => {
    const th = document.createElement('th');
    th.textContent = text;
    th.style.cssText = thStyle(idx >= 3 && idx <= 5 ? 'right' : 'left');
    fhr.appendChild(th);
  });
  ftHead.appendChild(fhr);
  fTable.appendChild(ftHead);
  const ftBody = document.createElement('tbody');
  if (payload.furniture.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = '（家具なし）';
    td.style.cssText = tdStyle('left', 'color:#999;font-style:italic;');
    tr.appendChild(td);
    ftBody.appendChild(tr);
  } else {
    for (const r of payload.furniture) {
      const tr = document.createElement('tr');
      [
        String(r.no),
        r.itemName,
        r.brand || '—',
        String(r.quantity),
        formatYen(r.unitPrice),
        formatYen(r.amount),
        r.sectionType,
        r.inputStatus
      ].forEach(
        (text, i) => {
          const td = document.createElement('td');
          td.textContent = text;
          td.style.cssText = tdStyle(i >= 3 && i <= 5 ? 'right' : 'left');
          tr.appendChild(td);
        }
      );
      ftBody.appendChild(tr);
    }
  }
  const fTrSum = document.createElement('tr');
  const fTdL = document.createElement('td');
  fTdL.colSpan = 7;
  fTdL.textContent = '家具 小計';
  fTdL.style.cssText = tdStyle('right', 'font-weight:700;');
  fTrSum.appendChild(fTdL);
  const fTdA = document.createElement('td');
  fTdA.textContent = formatYen(payload.furnitureTotal);
  fTdA.style.cssText = tdStyle('right', 'font-weight:700;');
  fTrSum.appendChild(fTdA);
  ftBody.appendChild(fTrSum);
  fTable.appendChild(ftBody);
  root.appendChild(fTable);

  const ah = document.createElement('div');
  ah.textContent = '【AI追加アイテム】';
  ah.style.cssText = 'font-size:11px;font-weight:700;margin:10px 0 4px;border-bottom:1px solid #ccc;padding-bottom:2px;';
  root.appendChild(ah);

  const aTable = document.createElement('table');
  aTable.style.cssText = 'width:100%;border-collapse:collapse;table-layout:fixed;font-size:9px;';
  const atHead = document.createElement('thead');
  const ahr = document.createElement('tr');
  ['No.', '品名', 'ブランド', '数量', '単価', '金額', '区分', '入力状態'].forEach((text, idx) => {
    const th = document.createElement('th');
    th.textContent = text;
    th.style.cssText = thStyle(idx >= 3 && idx <= 5 ? 'right' : 'left');
    ahr.appendChild(th);
  });
  atHead.appendChild(ahr);
  aTable.appendChild(atHead);
  const atBody = document.createElement('tbody');
  if (payload.aiItems.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = '（AI追加なし）';
    td.style.cssText = tdStyle('left', 'color:#999;font-style:italic;');
    tr.appendChild(td);
    atBody.appendChild(tr);
  } else {
    for (const r of payload.aiItems) {
      const tr = document.createElement('tr');
      [
        String(r.no),
        r.itemName,
        r.brand || '—',
        String(r.quantity),
        formatYen(r.unitPrice),
        formatYen(r.amount),
        r.sectionType,
        r.inputStatus
      ].forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        td.style.cssText = tdStyle(i >= 3 && i <= 5 ? 'right' : 'left');
        tr.appendChild(td);
      });
      atBody.appendChild(tr);
    }
  }
  const aTrSum = document.createElement('tr');
  const aTdL = document.createElement('td');
  aTdL.colSpan = 7;
  aTdL.textContent = 'AI追加 小計';
  aTdL.style.cssText = tdStyle('right', 'font-weight:700;');
  aTrSum.appendChild(aTdL);
  const aTdA = document.createElement('td');
  aTdA.textContent = formatYen(payload.aiItemsTotal);
  aTdA.style.cssText = tdStyle('right', 'font-weight:700;');
  aTrSum.appendChild(aTdA);
  atBody.appendChild(aTrSum);
  aTable.appendChild(atBody);
  root.appendChild(aTable);

  const note = document.createElement('div');
  note.textContent = '※建材はロス率込みの概算です。';
  note.style.cssText = 'margin-top:10px;font-size:8px;color:#666;';
  root.appendChild(note);

  return root;
}

function buildMaterialBoardPage(
  items: MaterialBoardItem[],
  pageLabel: string
): HTMLElement {
  const root = document.createElement('div');
  root.style.cssText = `box-sizing:border-box;width:720px;padding:18px 22px;background:#fff;color:#111;font-family:${FONT_STACK};font-size:10px;`;

  const h = document.createElement('div');
  h.textContent = `マテリアルボード ${pageLabel}`;
  h.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:12px;border-bottom:2px solid #111;padding-bottom:6px;';
  root.appendChild(h);

  const grid = document.createElement('div');
  grid.style.cssText =
    'display:grid;grid-template-columns:1fr 1fr;gap:12px 14px;align-items:start;';

  for (const item of items) {
    const card = document.createElement('div');
    card.style.cssText =
      'border:1px solid #333;border-radius:4px;padding:8px;display:flex;gap:10px;align-items:flex-start;background:#fafafa;';

    const imgWrap = document.createElement('div');
    imgWrap.style.cssText =
      'width:88px;height:88px;flex-shrink:0;border:1px solid #ccc;border-radius:4px;overflow:hidden;background:#e8e8e8;display:flex;align-items:center;justify-content:center;';
    if (item.textureUrl) {
      const img = document.createElement('img');
      img.crossOrigin = 'anonymous';
      img.src = item.textureUrl;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.alt = '';
      imgWrap.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.textContent = '—';
      ph.style.cssText = 'font-size:9px;color:#999;';
      imgWrap.appendChild(ph);
    }

    const text = document.createElement('div');
    text.style.cssText = 'min-width:0;flex:1;';
    const code = document.createElement('div');
    code.textContent = `品番: ${item.partCode}`;
    code.style.cssText = 'font-size:9px;font-weight:700;margin-bottom:2px;word-break:break-all;';
    const name = document.createElement('div');
    name.textContent = item.displayName;
    name.style.cssText = 'font-size:9px;margin-bottom:4px;line-height:1.3;';
    const use = document.createElement('div');
    use.textContent = `使用箇所: ${item.usages.join('、')}`;
    use.style.cssText = 'font-size:8px;color:#444;line-height:1.4;';
    text.appendChild(code);
    text.appendChild(name);
    text.appendChild(use);

    card.appendChild(imgWrap);
    card.appendChild(text);
    grid.appendChild(card);
  }

  root.appendChild(grid);
  return root;
}

function preloadTextureUrls(urls: string[]): Promise<void> {
  return Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          if (!url) {
            resolve();
            return;
          }
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = url;
        })
    )
  ).then(() => undefined);
}

async function renderNodeToPdfPage(
  pdf: jsPDF,
  node: HTMLElement,
  isFirst: boolean
): Promise<void> {
  node.style.position = 'fixed';
  node.style.left = '-9999px';
  node.style.top = '0';
  document.body.appendChild(node);
  try {
    const canvas = await html2canvas(node, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
    });
    const img = canvas.toDataURL('image/png', 1.0);
    const pageW = 210;
    const margin = 10;
    const maxW = pageW - 2 * margin;
    const maxH = 277;
    let w = maxW;
    let h = (canvas.height * w) / canvas.width;
    if (h > maxH) {
      const r = maxH / h;
      w *= r;
      h = maxH;
    }
    if (!isFirst) pdf.addPage();
    pdf.addImage(img, 'PNG', margin, margin, w, h);
  } finally {
    document.body.removeChild(node);
  }
}

export async function downloadEstimatePdf(payload: EstimateExportPayload): Promise<void> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const estimateEl = buildEstimatePage(payload);
  await renderNodeToPdfPage(pdf, estimateEl, true);

  const board = payload.materialBoard;
  if (board.length > 0) {
    const totalPages = Math.ceil(board.length / MATERIAL_BOARD_PAGE_SIZE);
    for (let p = 0; p < totalPages; p++) {
      const slice = board.slice(p * MATERIAL_BOARD_PAGE_SIZE, (p + 1) * MATERIAL_BOARD_PAGE_SIZE);
      const urls = slice.map((b) => b.textureUrl).filter(Boolean);
      await preloadTextureUrls(urls);
      const label = totalPages > 1 ? `(${p + 1}/${totalPages})` : '';
      const boardEl = buildMaterialBoardPage(slice, label);
      await renderNodeToPdfPage(pdf, boardEl, false);
    }
  }

  const out = pdf.output('blob');
  triggerBlobDownload(out, estimateExportFilename('pdf'));
}
