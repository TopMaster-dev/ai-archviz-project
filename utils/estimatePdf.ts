import * as html2canvasModule from 'html2canvas';
import { jsPDF } from 'jspdf';
import type { EstimateExportPayload, MaterialBoardItem } from './estimateExport.js';
import { estimateExportFilename, triggerBlobDownload, formatPartCodeForDisplay } from './estimateExport.js';

type Html2CanvasOptions = Partial<import('html2canvas').Options>;
type Html2CanvasFn = (el: HTMLElement, o?: Html2CanvasOptions) => Promise<HTMLCanvasElement>;
const html2canvas = (html2canvasModule as unknown as { default: Html2CanvasFn }).default;

const FONT_STACK = '"Segoe UI","Meiryo","Yu Gothic UI","Yu Gothic","Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif';

function formatYen(n: number): string {
  return `¥${n.toLocaleString('ja-JP')}`;
}

function thStyle(align: 'left' | 'right'): string {
  return `border:1px solid #333;padding:6px 8px;background:#f0f0f0;font-weight:700;vertical-align:middle;line-height:1.4;text-align:${align};`;
}

function tdStyle(align: 'left' | 'right', extra = ''): string {
  return `border:1px solid #333;padding:6px 8px;vertical-align:middle;line-height:1.4;text-align:${align};${extra}`;
}

/**
 * AI生成画像だけの1ページ（260728 クライアント #12「画像だけで1ページにして」）。
 * 見積本文には画像を入れない。3Dビューのスクリーンショットはそもそも渡ってこない（App 側で AI画像のみに限定）。
 */
function buildHeroImagePage(
  dataUrl: string,
  projectName: string | undefined,
  dateLabel: string,
  authorName?: string,
): HTMLElement {
  // 【260811 クライアント要望④】マテリアルボードと同じ A3横（1188×840px）で組む。
  // 室内のパースは横長が大半で、A4縦だと左右に大きな余白が出て小さく見えていた。
  // 見出し・日付・会社名の帯もボードに合わせ、2枚を並べたときに同じ体裁に見えるようにする。
  const root = document.createElement('div');
  root.style.cssText = `box-sizing:border-box;width:1188px;height:840px;background:#fff;color:#111;font-family:${FONT_STACK};display:flex;flex-direction:column;`;

  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;justify-content:space-between;align-items:center;background:#3a3a3a;color:#fff;padding:10px 18px;font-size:15px;font-weight:700;';
  const pn = document.createElement('span');
  pn.textContent = projectName || 'プロジェクト名';
  const dt = document.createElement('span');
  dt.textContent = `日付：${dateLabel}`;
  header.appendChild(pn);
  header.appendChild(dt);
  root.appendChild(header);

  // 画像は「切らずに収める」。cover にすると利用者が生成した絵の端が落ちるため contain 相当にする。
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;padding:16px 18px;display:flex;align-items:center;justify-content:center;min-height:0;';
  const img = document.createElement('img');
  img.crossOrigin = 'anonymous';
  img.src = dataUrl;
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;';
  img.alt = '';
  body.appendChild(img);
  root.appendChild(body);

  const footer = document.createElement('div');
  footer.style.cssText =
    'background:#3a3a3a;color:#fff;padding:8px 18px;font-size:13px;font-weight:700;text-align:right;';
  footer.textContent = authorName || '';
  root.appendChild(footer);

  return root;
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

  // 画像は見積本文には載せず、独立した1ページ（buildHeroImagePage）に分離した（260728 クライアント #12）。
  // 本文に埋めると縦に伸びて renderNodeToPdfPage の縮小が効き、表が小さく読みづらくなる副作用もあった。

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
    // 「区分」「入力状態」列はクライアント要望で削除（260720・3f）。
    ['No.', '明細', '数量', '単位', '単価', '金額', '備考'].forEach((text, idx) => {
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
      td.colSpan = 7;
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
          r.remark || ''
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
    tdL.colSpan = 6;
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
  ['No.', '品名', 'ブランド', '数量', '単価', '金額', '備考'].forEach((text, idx) => {
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
    td.colSpan = 7;
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
        r.remark || ''
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
  fTdL.colSpan = 6;
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
  ['No.', '品名', 'ブランド', '数量', '単価', '金額', '備考'].forEach((text, idx) => {
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
    td.colSpan = 7;
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
        r.remark || ''
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
  aTdL.colSpan = 6;
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

/** 面(SurfaceKey)→日本語ラベル。 */
const SURFACE_JP: Record<string, string> = { floor: '床', wall: '壁', ceiling: '天井', beam: '梁', baseboard: '巾木' };

/** マテリアルボード1スワッチ分（素材＋面ごとの通し番号ラベル）。 */
interface BoardEntry {
  it: MaterialBoardItem;
  label: string;
}

/**
 * マテリアルボード（A3横向き）。参考ボードに合わせ、1ページ＝横4×縦2＝最大8スワッチ＋中央の縦仕切り線の2面構成（260716）。
 * 面（床/壁/天井/梁）ごとに赤い「■壁」等の見出しを初出のスワッチ上に表示し、キャプションは「■壁1：品番【メーカー名】」形式。
 * 並びは 床→壁→天井→梁。9枚以上はページ分割（呼び出し側でチャンク）。幅1188px:高さ840px ＝ A3横(420:297)の比率。
 * ヘッダ＝プロジェクト名／日付(＋ページ番号)、フッタ＝会社名（無ければユーザー名）。
 */
function buildMaterialBoardPage(
  entries: BoardEntry[],
  projectName: string,
  authorName: string,
  dateLabel: string,
  pageNo: number,
  pageCount: number
): HTMLElement {
  const root = document.createElement('div');
  root.style.cssText = `box-sizing:border-box;width:1188px;height:840px;background:#fff;color:#111;font-family:${FONT_STACK};display:flex;flex-direction:column;`;

  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;justify-content:space-between;align-items:center;background:#3a3a3a;color:#fff;padding:10px 18px;font-size:15px;font-weight:700;';
  const pn = document.createElement('span');
  pn.textContent = projectName || 'プロジェクト名';
  const dt = document.createElement('span');
  dt.textContent = `日付：${dateLabel}${pageCount > 1 ? `　（${pageNo}/${pageCount}）` : ''}`;
  header.appendChild(pn);
  header.appendChild(dt);
  root.appendChild(header);

  // body は position:relative（中央の縦仕切り線を絶対配置するため・参考ボードと同じ2面構成）。
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;padding:16px 18px;position:relative;';
  const divider = document.createElement('div');
  divider.style.cssText = 'position:absolute;top:16px;bottom:16px;left:50%;width:1px;background:#bbb;';
  body.appendChild(divider);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:14px 16px;align-content:start;position:relative;';
  // 各カテゴリ（面）の最初のスワッチの上に赤い「■壁」等の見出しを1回だけ出す（ページ内で初出のとき）。
  // 見出しスロットは常に固定高さにして、見出しの有無でスワッチの高さがズレないようにする。
  const seenSurface = new Set<string>();
  for (const { it, label } of entries) {
    const card = document.createElement('div');
    card.style.cssText = 'display:flex;flex-direction:column;';

    const catSlot = document.createElement('div');
    if (!seenSurface.has(it.surface)) {
      seenSurface.add(it.surface);
      catSlot.textContent = `■${SURFACE_JP[it.surface] ?? ''}`;
      // 壁/床/天井などの面見出しは黒（クライアント要望・260720。旧: 赤 #cc0000）。
      catSlot.style.cssText = 'height:20px;line-height:20px;color:#111;font-size:14px;font-weight:800;margin-bottom:2px;';
    } else {
      catSlot.style.cssText = 'height:20px;margin-bottom:2px;';
    }
    card.appendChild(catSlot);

    const imgWrap = document.createElement('div');
    imgWrap.style.cssText =
      'width:100%;height:264px;border:1px solid #ccc;overflow:hidden;background:#ececec;display:flex;align-items:center;justify-content:center;';
    if (it.textureUrl) {
      const img = document.createElement('img');
      img.crossOrigin = 'anonymous';
      img.src = it.textureUrl;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.alt = '';
      imgWrap.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.textContent = '—';
      ph.style.cssText = 'font-size:14px;color:#999;';
      imgWrap.appendChild(ph);
    }
    const cap = document.createElement('div');
    // ボードは height:840px 固定のため、品番＋メーカー名が長いとキャプションが何行も折り返し、
    // 2行目のカードが用紙外へ押し出されて html2canvas に切り取られる（＝「縦に並ぶ／崩れる」ように見える）。
    // 2行で打ち切って高さを一定に保つ（260728 クライアント #3a の再発防止）。
    cap.style.cssText =
      'background:#ededed;padding:4px 8px;font-size:11px;font-weight:600;border:1px solid #ccc;border-top:none;' +
      'word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:34px;';
    const mark = document.createElement('span');
    mark.textContent = '■';
    mark.style.cssText = 'color:#111;margin-right:2px;'; // 黒（クライアント要望・260720。旧: 赤 #cc0000）
    cap.appendChild(mark);
    // 品番はユーザー入力の modelNumber を優先し、無ければ内部 partCode（productId）にフォールバック（3e・260720）。
    // 内部IDは Cloudinary のパスで長大なため、表示用に整形する（260728 クライアント指摘: 文字が切れて読めない）。
    cap.appendChild(
      document.createTextNode(
        `${label}：${formatPartCodeForDisplay(it.modelNumber, it.partCode)}【${it.brand || 'メーカー名'}】`
      )
    );

    card.appendChild(imgWrap);
    card.appendChild(cap);
    grid.appendChild(card);
  }
  body.appendChild(grid);
  root.appendChild(body);

  const footer = document.createElement('div');
  footer.style.cssText =
    'background:#3a3a3a;color:#fff;padding:8px 18px;font-size:13px;font-weight:700;text-align:center;';
  footer.textContent = authorName || '—';
  root.appendChild(footer);

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

/**
 * A4縦ページへ描画する。
 *
 * 【重要・260811】jsPDF は用紙サイズと向きを「直前の addPage の指定」として持ち回る。
 * 画像ページを A3横にしたことで、引数なしの addPage() を使うと見積本文が A3横を引き継いで
 * 拡大され、レイアウトが崩れる。必ず 'a4','portrait' を明示すること。
 */
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
    if (!isFirst) pdf.addPage('a4', 'portrait');
    // 縦長で maxH に収めるため幅を縮めたぶん、x を margin 固定にすると縮小分が全部「右の余白」になり
    // 内容が左に寄って見える（260728 クライアント #12）。A3ボード側（renderBoardToA3Page）と同じく水平中央へ。
    pdf.addImage(img, 'PNG', (pageW - w) / 2, margin, w, h);
  } finally {
    document.body.removeChild(node);
  }
}

/** マテリアルボードを A3 横ページに描画（マテリアルボードのみ A3横・260623）。
 *  幅いっぱい(420mm)に配置し内部の 283px=100mm を保つ。高さがA3を超える場合のみ縮小。 */
async function renderBoardToA3Page(pdf: jsPDF, node: HTMLElement): Promise<void> {
  node.style.position = 'fixed';
  node.style.left = '-9999px';
  node.style.top = '0';
  document.body.appendChild(node);
  try {
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const img = canvas.toDataURL('image/png', 1.0);
    pdf.addPage('a3', 'landscape');
    const pageW = 420;
    const pageH = 297;
    let w = pageW;
    let h = (canvas.height * w) / canvas.width;
    if (h > pageH) {
      const r = pageH / h;
      w *= r;
      h = pageH;
    }
    pdf.addImage(img, 'PNG', (pageW - w) / 2, 0, w, h);
  } finally {
    document.body.removeChild(node);
  }
}

export async function downloadEstimatePdf(payload: EstimateExportPayload): Promise<void> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  // 画像は html2canvas 前に読み込んでおく（未ロードだと白紙で写るため・board 画像と同じ方式）。
  // roomImageDataUrl は App 側で「AI生成画像があるときだけ」渡される（3Dビューのスクショは渡さない・260728 #12）。
  const heroUrl = payload.roomImageDataUrl;
  if (heroUrl) {
    await preloadTextureUrls([heroUrl]);
    /*
      画像だけで1ページ（先頭）。260811 要望④で A3横へ変更（マテリアルボードと同じ用紙）。
      1ページ目を A3横にするため、jsPDF は portrait/a4 で作ったあと A3横を addPage して
      最初の空ページを消す。以降の見積本文は 'a4','portrait' を明示して追加する
      （明示しないと直前の A3横を引き継いでレイアウトが崩れる）。
    */
    const heroDate = new Date(payload.generatedAtIso).toLocaleDateString('ja-JP');
    await renderBoardToA3Page(
      pdf,
      buildHeroImagePage(heroUrl, payload.projectName, heroDate, payload.authorName),
    );
    pdf.deletePage(1); // 生成時に作られた空の A4縦ページを除去（画像ページを1ページ目にする）
  }
  const estimateEl = buildEstimatePage(payload);
  await renderNodeToPdfPage(pdf, estimateEl, !heroUrl);

  const board = payload.materialBoard;
  if (board.length > 0) {
    await preloadTextureUrls(board.map((b) => b.textureUrl).filter(Boolean));
    const dateLabel = new Date(payload.generatedAtIso).toLocaleDateString('ja-JP');
    // 面ごとの通し番号（床1/床2/壁1…）。board は面順（床→壁→天井→梁）にソート済み。
    const counters: Record<string, number> = {};
    const entries: BoardEntry[] = board.map((it) => {
      const n = (counters[it.surface] = (counters[it.surface] ?? 0) + 1);
      return { it, label: `${SURFACE_JP[it.surface] ?? ''}${n}` };
    });
    // 横4×縦2＝1ページ8枚。9枚以上はページを増やす（260716）。
    const PER_PAGE = 8;
    const pageCount = Math.ceil(entries.length / PER_PAGE);
    for (let i = 0, page = 0; i < entries.length; i += PER_PAGE, page += 1) {
      const chunk = entries.slice(i, i + PER_PAGE);
      const boardEl = buildMaterialBoardPage(chunk, payload.projectName, payload.authorName, dateLabel, page + 1, pageCount);
      await renderBoardToA3Page(pdf, boardEl);
    }
  }

  const out = pdf.output('blob');
  triggerBlobDownload(out, estimateExportFilename('pdf'));
}
