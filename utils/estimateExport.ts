import type { AiEstimateItem, FurnitureItem } from '../types.js';
import type { BaseboardEstimateRow } from './baseboardEstimate.js';
import type { EstimateMetaOverride } from '../lib/project/projectState.js';
import { surfaceFromMeshName } from './meshSurface.js';

/** App の costBreakdown 行と同一形状 */
export interface CostBreakdownEntry {
  meshName: string;
  cost: number;
  area: number;
  unitPrice?: number;
  lossFactor?: number;
  prodName: string;
  brand: string;
  modelNumber?: string; // 品番（建材アップロード時に任意入力・260630）
  textureUrl?: string;
  productId: string;
  /** 商品URL（見積パネルで任意入力・260728 #6）。備考へ `URL:` として出す。 */
  productUrl?: string;
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
  /** ユーザーが入力した品番（あれば）。無ければマテリアルボードは partCode（内部productId）へフォールバック（3e・260720）。 */
  modelNumber?: string;
  displayName: string;
  brand: string;
  /** 実際に貼られた面（3Dビューのメッシュ由来・床/壁/天井/梁）。面ごとに1スワッチ（260716）。 */
  surface: SurfaceKey;
  usages: string[];
}

export interface EstimateExportPayload {
  generatedAtIso: string;
  /** マテリアルボードのヘッダ（プロジェクト名）・フッタ（会社名、無ければユーザー名）（260623）。 */
  projectName: string;
  authorName: string;
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
  /** 見積書PDF先頭に載せる「現在表示中の画像」（AI生成画像 or 3D/2Dビュー）。書き出し時に付与（3h・260720）。CSVでは未使用。 */
  roomImageDataUrl?: string;
}

export interface BuildEstimateOptions {
  wallDivisions: Record<number, number>;
  /** マテリアルボードのヘッダ/フッタ表示用（260623）。 */
  projectName?: string;
  authorName?: string;
  /** 巾木ライン（壁延長 × m単価）。CSV/PDF の【巾木】セクションへ反映（260613）。 */
  baseboardRows?: BaseboardEstimateRow[];
  /**
   * 建材・巾木のメタ上書き（260728 #6）。キーは `material:<productId>` / `baseboard:<productId>`。
   * 旧 materialMemoByProductId / baseboardMemoByProductId を統合したもの。
   * 名称・メーカー・品番は行の表示名へ、メモとURLは備考へ反映する（家具/AI項目の既存挙動と揃える）。
   */
  overridesByKey?: Record<string, EstimateMetaOverride>;
}

/** 上書きを引く（未設定は undefined）。 */
function materialOverride(options: BuildEstimateOptions, productId: string): EstimateMetaOverride | undefined {
  return options.overridesByKey?.[`material:${productId}`];
}
function baseboardOverride(options: BuildEstimateOptions, productId: string): EstimateMetaOverride | undefined {
  return options.overridesByKey?.[`baseboard:${productId}`];
}

/**
 * 備考欄の文字列を組み立てる（全区分で共通）。
 *
 * 以前は建材・巾木・家具・AI追加でそれぞれ別々に組み立てており、巾木だけ品番が抜けていた
 * （入力・保存はされるのに見積書に出ない・260811 要望③）。並び順も区分ごとに違ったため、
 * ここに一本化して「メモ / 品番 / URL」で揃える。
 */
export function buildRemark(parts: {
  memo?: string;
  modelNumber?: string;
  productUrl?: string;
}): string {
  return [
    parts.memo,
    parts.modelNumber ? `品番:${parts.modelNumber}` : '',
    parts.productUrl ? `URL:${parts.productUrl}` : '',
  ]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' / ');
}

function roundYen(n: number): number {
  return Math.round(n);
}

/**
 * メッシュ名から「3Dで実際に貼られた面」を判定する（見積セクション＋マテリアルボードの共通の真実源）。
 *
 * クライアント要望（260728 #3b）:「見積の 壁・床・天井 区分は素材カタログのカテゴリではなく、
 * 3Dビューで実際に貼られた面（床/壁/天井/梁）で判定し、マテリアルボードと一致させる」。
 *
 * Sketch_* の厳密名を最優先し、取込み3Dモデル（任意のメッシュ名）だけ名前ヒューリスティックで拾う。
 * 判定順は固定（ceiling を floor より先に見る＝'floor_ceiling' のような複合名の取り違え防止）。
 * ここを変えると PDF/CSV のセクションとマテリアルボードのスワッチが同時に変わる（呼び出しは本関数1本）。
 */
/**
 * マテリアルボード／CSV に出す「品番」の表示用テキスト（260728 クライアント指摘）。
 *
 * 品番未入力の素材は内部ID（productId）へフォールバックする仕様だが、その中身は
 * Cloudinary の public_id（例: `materials/generic/61ajziJ6ADL._AC_UF1000_1000_QL80_`）で、
 * 商品情報として意味が無いうえ長すぎてキャプションが溢れていた。
 * パス形式なら最後のセグメントだけにし、拡張子と末尾の記号を落として短く整える。
 * それでも長い場合は末尾を省略する（レイアウトを崩さないため）。
 */
export function formatPartCodeForDisplay(
  modelNumber: string | undefined,
  partCode: string | undefined,
  maxLen = 28,
): string {
  const explicit = (modelNumber ?? '').trim();
  if (explicit) return explicit.length > maxLen ? `${explicit.slice(0, maxLen - 1)}…` : explicit;

  const raw = (partCode ?? '').trim();
  if (!raw) return '品番未設定';
  // パス形式（materials/generic/xxx）なら末尾セグメントのみ
  const last = raw.split('/').pop() ?? raw;
  // 拡張子と、末尾に残りがちな区切り記号を除去
  const noExt = last.replace(/\.(png|jpe?g|webp|avif|gif|tiff?)$/i, '');
  const trimmed = noExt.replace(/[._\-]+$/, '');
  const out = trimmed || last;
  return out.length > maxLen ? `${out.slice(0, maxLen - 1)}…` : out;
}

export function classifySurface(meshName: string): SurfaceKey {
  // 1) スケッチ由来の確定名（最優先・完全一致/前方一致）
  if (meshName === 'Sketch_Floor') return 'floor';
  if (meshName === 'Sketch_Ceiling') return 'ceiling';
  if (meshName.startsWith('Beam_')) return 'beam';
  if (meshName.startsWith('Sketch_Wall_') || meshName === 'Sketch_UpperBand') return 'wall';

  // 2) 取込み3Dモデルの任意メッシュ名は共有関数へ委譲する。
  //    RoomViewer（3Dで面をクリックしたときの分類）と同じ関数を使うことで、
  //    「3Dでは床なのにPDFでは壁」というズレが原理的に起きないようにする。
  return surfaceFromMeshName(meshName);
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
  modelNumber?: string;
  productId: string;
  memo?: string;
  /** 商品URL。備考の組み立ては buildRemark に一本化する（260811）。 */
  productUrl?: string;
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
      // 品番（任意入力）を備考へ。家具/AI項目の備考表記（品番:…）と統一（260630）。
      remark: buildRemark({ memo: row.memo, modelNumber: row.modelNumber, productUrl: row.productUrl }),
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
        modelNumber: item.modelNumber,
        productId: item.productId,
        memo: materialOverride(options, item.productId)?.memo,
        productUrl: materialOverride(options, item.productId)?.productUrl ?? item.productUrl,
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
    remark: buildRemark({
      memo: baseboardOverride(options, r.productId)?.memo,
      modelNumber: r.modelNumber,
      productUrl: r.productUrl ?? baseboardOverride(options, r.productId)?.productUrl,
    }),
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

  // マテリアルボード: 実際に貼られた「面」ごとに1スワッチ（同じ素材でも面が違えば別スワッチ＝表と一致・260716）。
  // キーは surface|productId。天井・梁も必ず含まれる（旧: productId のみで集約し最初の面だけ表示＝天井/梁が抜けていた）。
  const boardMap = new Map<string, MaterialBoardItem>();
  for (const item of costBreakdown) {
    const pid = aggregateKeyForProduct(item);
    const surface = classifySurface(item.meshName);
    const label = usageLabelFromMesh(item.meshName, wallDivisions);
    const key = `${surface}|${pid}`;
    const existing = boardMap.get(key);
    if (existing) {
      if (!existing.usages.includes(label)) existing.usages.push(label);
    } else {
      boardMap.set(key, {
        productId: item.productId || pid,
        textureUrl: item.textureUrl ?? '',
        partCode: item.productId || pid,
        modelNumber: item.modelNumber, // ユーザー入力の品番（あればボード表記に優先・3e・260720）
        displayName: `${item.brand} ${item.prodName}`.trim(),
        brand: item.brand,
        surface,
        usages: [label],
      });
    }
  }
  for (const b of boardMap.values()) {
    b.usages.sort((a, c) => a.localeCompare(c, 'ja'));
  }
  // 面の並び順は 床→壁→天井→梁（クライアント指定の「床・壁・天井・梁」）。同一面内は表示名順。
  const SURFACE_ORDER: Record<SurfaceKey, number> = { floor: 0, wall: 1, ceiling: 2, beam: 3, baseboard: 4 };
  const materialBoard = [...boardMap.values()].sort((a, b) => {
    const so = (SURFACE_ORDER[a.surface] ?? 9) - (SURFACE_ORDER[b.surface] ?? 9);
    return so !== 0 ? so : a.displayName.localeCompare(b.displayName, 'ja');
  });

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
      remark: buildRemark({ memo: f.customMemo, modelNumber: f.modelNumber, productUrl: f.productUrl }),
      sectionType: '3D確定',
      inputStatus: price > 0 ? '完了' : '未入力',
    });
  }

  const aiItems: AiEstimateExportRow[] = [];
  let ano = 1;
  for (const item of aiEstimateItems) {
    const price = item.price ?? 0;
    // 入力状態は画面の未入力判定（名称＋金額）と揃える（ブランドは任意・260716）。名称か金額が欠ければ未入力。
    const complete = !!(item.name ?? '').trim() && price > 0;
    aiItems.push({
      no: ano++,
      itemName: (item.name || 'AI追加項目').trim(),
      brand: (item.brand || '').trim(),
      quantity: 1,
      unitPrice: roundYen(price),
      amount: roundYen(price),
      remark: buildRemark({ memo: item.memo, modelNumber: item.modelNumber, productUrl: item.productUrl }),
      sectionType: 'AI追加',
      inputStatus: complete ? '完了' : '未入力',
    });
  }

  // 巾木は建材費の一部として materialsTotal に含める（grandTotal も同様）。
  const materialsTotalWithBaseboard = materialsTotal + baseboardTotal;
  return {
    generatedAtIso: new Date().toISOString(),
    projectName: options.projectName ?? '',
    authorName: options.authorName ?? '',
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

export function estimateExportFilename(ext: 'pdf' | 'xlsx'): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `概算見積_${y}${m}${day}.${ext}`;
}

/** Blob をダウンロードさせる（PDF/Excel 共通）。 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/*
 * CSV 書き出しは 260811 クライアント指示により廃止し、Excel（.xlsx）へ差し替えた。
 * 理由: CSVは列幅・書式・画像を保持できず、「PDFのように正確に」というご要望を満たせないため。
 * 実装は utils/estimateXlsx.ts（downloadEstimateXlsx）。
 */
