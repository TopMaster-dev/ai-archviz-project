import type { AiEstimateItem, FurnitureItem } from '../types.js';
import type { BaseboardEstimateRow } from './baseboardEstimate.js';

/** App の costBreakdown 行と同一形状 */
export interface CostBreakdownEntry {
  meshName: string;
  cost: number;
  area: number;
  unitPrice?: number;
  lossFactor?: number;
  prodName: string;
  brand: string;
  textureUrl?: string;
  productId: string;
}

export interface MaterialExportRow {
  no: number;
  detailName: string;
  spec: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  remark: string;
  sectionType: '3D確定';
  inputStatus: '完了' | '未入力';
}

export interface FurnitureExportRow {
  no: number;
  itemName: string;
  brand: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  remark: string;
  sectionType: '3D確定';
  inputStatus: '完了' | '未入力';
}

export interface AiEstimateExportRow {
  no: number;
  itemName: string;
  brand: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  remark: string;
  sectionType: 'AI追加';
  inputStatus: '完了' | '未入力';
}

export type SurfaceKey = 'floor' | 'ceiling' | 'wall' | 'beam' | 'baseboard';

export interface MaterialSectionPayload {
  key: SurfaceKey;
  title: string;
  rows: MaterialExportRow[];
  subtotal: number;
}

export interface MaterialBoardItem {
  productId: string;
  textureUrl: string;
  partCode: string;
  displayName: string;
  usages: string[];
}

export interface EstimateExportPayload {
  generatedAtIso: string;
  materialsTotal: number;
  furnitureTotal: number;
  aiItemsTotal: number;
  grandTotal: number;
  /** 後方互換・集計行のフラット一覧 */
  materials: MaterialExportRow[];
  materialSections: MaterialSectionPayload[];
  materialBoard: MaterialBoardItem[];
  furniture: FurnitureExportRow[];
  aiItems: AiEstimateExportRow[];
}

export interface BuildEstimateOptions {
  wallDivisions: Record<number, number>;
  /** 建材ラインのメモ（productId キー）。CSV/PDF の備考へ反映（4c）。 */
  materialMemoByProductId?: Record<string, string>;
  /** 巾木ライン（壁延長 × m単価）。CSV/PDF の【巾木】セクションへ反映（260613）。 */
  baseboardRows?: BaseboardEstimateRow[];
}

function roundYen(n: number): number {
  return Math.round(n);
}

export function classifySurface(meshName: string): SurfaceKey {
  if (meshName === 'Sketch_Floor') return 'floor';
  if (meshName === 'Sketch_Ceiling') return 'ceiling';
  if (meshName.startsWith('Beam_')) return 'beam';
  return 'wall';
}

/** 単一ルーム前提：メッシュ名から使用箇所ラベル */
export function usageLabelFromMesh(meshName: string, wallDivisions: Record<number, number>): string {
  if (meshName === 'Sketch_Floor') return '床';
  if (meshName === 'Sketch_Ceiling') return '天井';
  if (meshName === 'Sketch_UpperBand') return '上部壁';
  if (meshName.startsWith('Beam_')) return '梁';
  if (!meshName.startsWith('Sketch_Wall_')) return meshName;

  const rest = meshName.replace('Sketch_Wall_', '');
  const parts = rest.split('_');
  const wallIndex0 = parseInt(parts[0], 10);
  const boundaryNo = Number.isFinite(wallIndex0) ? wallIndex0 + 1 : 1;
  const divs = wallDivisions[wallIndex0] || 1;

  if (divs === 1 || parts.length < 2) {
    return `壁（境界 ${boundaryNo}）`;
  }
  const subIdx = parseInt(parts[1], 10);
  const seg = subIdx === 0 ? '腰壁下' : '腰壁上';
  return `壁（境界 ${boundaryNo}・${seg}）`;
}

function aggregateKeyForProduct(item: CostBreakdownEntry): string {
  return item.productId || `${item.brand}|${item.prodName}|${item.textureUrl ?? ''}`;
}

type AggRow = {
  area: number;
  cost: number;
  unitPrice: number;
  brand: string;
  prodName: string;
  productId: string;
  memo?: string;
};

function buildSectionRows(
  map: Map<string, AggRow>,
  startNo: number
): { rows: MaterialExportRow[]; nextNo: number } {
  const rows: MaterialExportRow[] = [];
  let no = startNo;
  for (const row of map.values()) {
    const qty = row.area;
    rows.push({
      no: no++,
      detailName: `${row.brand} ${row.prodName}`.trim(),
      spec: 'ロス率込み・㎡単価',
      quantity: Math.round(qty * 1000) / 1000,
      unit: '㎡',
      unitPrice: roundYen(row.unitPrice),
      amount: roundYen(row.cost),
      remark: row.memo ?? '',
      sectionType: '3D確定',
      inputStatus: '完了',
    });
  }
  return { rows, nextNo: no };
}

export function buildEstimateExportPayload(
  costBreakdown: CostBreakdownEntry[],
  furnitureItems: FurnitureItem[],
  aiEstimateItems: AiEstimateItem[],
  options: BuildEstimateOptions
): EstimateExportPayload {
  const { wallDivisions } = options;
  const materialsTotal = costBreakdown.reduce((acc, item) => acc + item.cost, 0);
  const furnitureTotal = furnitureItems.reduce((acc, f) => acc + (f.customPrice ?? 0), 0);
  const aiItemsTotal = aiEstimateItems.reduce((acc, item) => acc + (item.price ?? 0), 0);

  const floorMap = new Map<string, AggRow>();
  const ceilingMap = new Map<string, AggRow>();
  const wallMap = new Map<string, AggRow>();
  const beamMap = new Map<string, AggRow>();

  for (const item of costBreakdown) {
    const key = aggregateKeyForProduct(item);
    const surface = classifySurface(item.meshName);
    const target =
      surface === 'floor' ? floorMap : surface === 'ceiling' ? ceilingMap : surface === 'beam' ? beamMap : wallMap;
    const existing = target.get(key);
    if (existing) {
      existing.area += item.area;
      existing.cost += item.cost;
    } else {
      target.set(key, {
        area: item.area,
        cost: item.cost,
        unitPrice: item.unitPrice ?? 0,
        brand: item.brand,
        prodName: item.prodName,
        productId: item.productId,
        memo: options.materialMemoByProductId?.[item.productId],
      });
    }
  }

  let globalNo = 1;
  const materialSections: MaterialSectionPayload[] = [];

  const floorRows = buildSectionRows(floorMap, globalNo);
  globalNo = floorRows.nextNo;
  materialSections.push({
    key: 'floor',
    title: '床',
    rows: floorRows.rows,
    subtotal: roundYen([...floorMap.values()].reduce((s, r) => s + r.cost, 0)),
  });

  const ceilRows = buildSectionRows(ceilingMap, globalNo);
  globalNo = ceilRows.nextNo;
  materialSections.push({
    key: 'ceiling',
    title: '天井',
    rows: ceilRows.rows,
    subtotal: roundYen([...ceilingMap.values()].reduce((s, r) => s + r.cost, 0)),
  });

  const wallRows = buildSectionRows(wallMap, globalNo);
  globalNo = wallRows.nextNo;
  materialSections.push({
    key: 'wall',
    title: '壁',
    rows: wallRows.rows,
    subtotal: roundYen([...wallMap.values()].reduce((s, r) => s + r.cost, 0)),
  });

  const beamRows = buildSectionRows(beamMap, globalNo);
  globalNo = beamRows.nextNo;
  materialSections.push({
    key: 'beam',
    title: '梁',
    rows: beamRows.rows,
    subtotal: roundYen([...beamMap.values()].reduce((s, r) => s + r.cost, 0)),
  });

  // 巾木ライン（壁延長 × m単価）。面積ベースと単位（m）が異なるため別セクション（260613）。
  const baseboardSrc = options.baseboardRows ?? [];
  const baseboardExportRows: MaterialExportRow[] = baseboardSrc.map((r) => ({
    no: globalNo++,
    detailName: `${r.brand} ${r.productName}`.trim() || '巾木',
    spec: '壁延長・m単価',
    quantity: Math.round(r.lengthM * 1000) / 1000,
    unit: 'm',
    unitPrice: roundYen(r.unitPrice),
    amount: roundYen(r.cost),
    remark: '',
    sectionType: '3D確定',
    inputStatus: r.unitPrice > 0 ? '完了' : '未入力',
  }));
  const baseboardTotal = baseboardSrc.reduce((s, r) => s + r.cost, 0);
  if (baseboardExportRows.length > 0) {
    materialSections.push({
      key: 'baseboard',
      title: '巾木',
      rows: baseboardExportRows,
      subtotal: roundYen(baseboardTotal),
    });
  }

  const materialsFlat: MaterialExportRow[] = [
    ...floorRows.rows,
    ...ceilRows.rows,
    ...wallRows.rows,
    ...beamRows.rows,
    ...baseboardExportRows,
  ];

  const boardMap = new Map<string, MaterialBoardItem>();
  for (const item of costBreakdown) {
    const pid = aggregateKeyForProduct(item);
    const label = usageLabelFromMesh(item.meshName, wallDivisions);
    const existing = boardMap.get(pid);
    if (existing) {
      if (!existing.usages.includes(label)) existing.usages.push(label);
    } else {
      boardMap.set(pid, {
        productId: item.productId || pid,
        textureUrl: item.textureUrl ?? '',
        partCode: item.productId || pid,
        displayName: `${item.brand} ${item.prodName}`.trim(),
        usages: [label],
      });
    }
  }
  for (const b of boardMap.values()) {
    b.usages.sort((a, c) => a.localeCompare(c, 'ja'));
  }
  const materialBoard = [...boardMap.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'ja')
  );

  const furniture: FurnitureExportRow[] = [];
  let fno = 1;
  for (const f of furnitureItems) {
    const price = f.customPrice ?? 0;
    furniture.push({
      no: fno++,
      itemName: (f.customName || f.name || f.type || '家具').trim(),
      brand: (f.customBrand || f.type || '').trim(),
      quantity: 1,
      unitPrice: roundYen(price),
      amount: roundYen(price),
      remark: [f.customMemo, f.modelNumber ? `品番:${f.modelNumber}` : '', f.productUrl ? `URL:${f.productUrl}` : '']
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
        .join(' / '),
      sectionType: '3D確定',
      inputStatus: price > 0 ? '完了' : '未入力',
    });
  }

  const aiItems: AiEstimateExportRow[] = [];
  let ano = 1;
  for (const item of aiEstimateItems) {
    const price = item.price ?? 0;
    aiItems.push({
      no: ano++,
      itemName: (item.name || 'AI追加項目').trim(),
      brand: (item.brand || '').trim(),
      quantity: 1,
      unitPrice: roundYen(price),
      amount: roundYen(price),
      remark: [item.memo, item.modelNumber ? `品番:${item.modelNumber}` : '', item.productUrl ? `URL:${item.productUrl}` : '']
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
        .join(' / '),
      sectionType: 'AI追加',
      inputStatus: price > 0 ? '完了' : '未入力',
    });
  }

  // 巾木は建材費の一部として materialsTotal に含める（grandTotal も同様）。
  const materialsTotalWithBaseboard = materialsTotal + baseboardTotal;
  return {
    generatedAtIso: new Date().toISOString(),
    materialsTotal: roundYen(materialsTotalWithBaseboard),
    furnitureTotal: roundYen(furnitureTotal),
    aiItemsTotal: roundYen(aiItemsTotal),
    grandTotal: roundYen(materialsTotalWithBaseboard + furnitureTotal + aiItemsTotal),
    materials: materialsFlat,
    materialSections,
    materialBoard,
    furniture,
    aiItems,
  };
}

export function estimateExportFilename(ext: 'pdf' | 'csv'): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `概算見積_${y}${m}${day}.${ext}`;
}

function escapeCsvField(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildEstimateCsv(payload: EstimateExportPayload): string {
  const lines: string[] = [];
  const pushRow = (cells: (string | number)[]) => {
    lines.push(cells.map((c) => escapeCsvField(String(c))).join(','));
  };

  pushRow([`概算見積もり（出力 ${payload.generatedAtIso}）`]);
  lines.push('');

  const sectionTitles: Record<SurfaceKey, string> = {
    floor: '【床】',
    ceiling: '【天井】',
    wall: '【壁】',
    beam: '【梁】',
    baseboard: '【巾木】',
  };

  for (const sec of payload.materialSections) {
    pushRow([sectionTitles[sec.key]]);
    pushRow(['No.', '明細名称', '仕様', '数量', '単位', '単価', '金額', '区分', '入力状態', '備考']);
    for (const r of sec.rows) {
      pushRow([
        r.no,
        r.detailName,
        r.spec,
        r.quantity,
        r.unit,
        r.unitPrice,
        r.amount,
        r.sectionType,
        r.inputStatus,
        r.remark,
      ]);
    }
    pushRow([`${sec.title} 小計`, '', '', '', '', '', sec.subtotal, '', '', '']);
    lines.push('');
  }

  pushRow(['【家具リスト】']);
  pushRow(['No.', '品名', 'ブランド', '数量', '単価', '金額', '区分', '入力状態', '備考']);
  for (const r of payload.furniture) {
    pushRow([
      r.no,
      r.itemName,
      r.brand,
      r.quantity,
      r.unitPrice,
      r.amount,
      r.sectionType,
      r.inputStatus,
      r.remark,
    ]);
  }
  lines.push('');
  pushRow(['【AI追加アイテム】']);
  pushRow(['No.', '品名', 'ブランド', '数量', '単価', '金額', '区分', '入力状態', '備考']);
  for (const r of payload.aiItems) {
    pushRow([
      r.no,
      r.itemName,
      r.brand,
      r.quantity,
      r.unitPrice,
      r.amount,
      r.sectionType,
      r.inputStatus,
      r.remark,
    ]);
  }
  pushRow(['', '', '', '', '税込合計', payload.grandTotal, '', '', '']);
  lines.push('');

  pushRow(['【マテリアルボード】']);
  pushRow(['品番', '表示名', '使用箇所', 'テクスチャURL']);
  for (const b of payload.materialBoard) {
    pushRow([b.partCode, b.displayName, b.usages.join(' / '), b.textureUrl]);
  }

  return '\uFEFF' + lines.join('\r\n');
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadEstimateCsv(payload: EstimateExportPayload): void {
  const csv = buildEstimateCsv(payload);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  triggerBlobDownload(blob, estimateExportFilename('csv'));
}
