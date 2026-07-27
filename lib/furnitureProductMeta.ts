import type { FurnitureCatalogItem } from '../types.js';

/**
 * 家具モデル → 商品メタ（メーカー/品番/単価/商品URL）の対応表（Tier1・260620 クライアント要望）。
 *
 * 目的: 「AIエージェントが自動配置した家具のメーカー・品番・金額・商品URLを提示する」体験(Tier2)の土台として、
 * まず “カタログ家具を配置したら見積もりへメーカー/品番/単価/URLが自動で入る” ようにする。
 * 配置時（App.tsx handleAddFurniture）にこの対応表を引き、FurnitureItem の customBrand/customPrice/
 * modelNumber/productUrl に補完する。見積もりUIはこれらをそのまま表示・合計・編集できる。
 *
 * 照合の優先順位: id（カタログの一意ID／Cloudinary public_id 等）→ name（ファイル名）→ type（カテゴリ既定）。
 * 上位で見つかった項目を優先し、欠けている項目だけ下位で補う。
 *
 * 運用: 実データは運営/クライアントがこの表に追記する（id/name は家具パレットのカタログ表記に合わせる）。
 * 下記はローカル同梱モデル（public/models/catalog.json の chair_1 等）に入れた “動作確認用の例” で、値はダミー。
 * 実運用では各行を実在の商品情報（メーカー名・品番・税抜単価・商品ページURL）に差し替える。
 * Cloudinary 上の家具は BY_ID に public_id を、または BY_NAME にファイル名を追記すれば同様に反映される。
 *
 * セキュリティ: productUrl は見積もりUI側で http(s) のみ開く既存ガードに準拠（ここでは検証しない）。
 */
export interface FurnitureProductMeta {
  /** メーカー/ブランド名。見積もりの「ブランド」欄に入る。 */
  brand?: string;
  /** 品番/型番。見積もりの「品番」欄に入る。 */
  modelNumber?: string;
  /** 単価（円・税抜想定）。見積もりの「単価 × 数量」と合計に反映。 */
  price?: number;
  /** 商品ページURL。見積もりの「商品URL」欄＋↗リンクに入る。 */
  productUrl?: string;
}

/**
 * ダミー（動作確認用サンプル）の対応表を使うかどうか（既定 false＝使わない）。
 *
 * 260728 クライアント #8:「提案される商品が実在しない／URLが404」の主因の一つが、この対応表のサンプル値
 * （'（例）サンプル・ファニチャー' / 'SAMPLE-SOFA' / https://example.com/…）が
 * 実データのような顔をして見積・エージェント提案に流れ込んでいたこと。既定でサンプルを出さない。
 *
 * 実データを入れるときは BY_ID / BY_NAME に実在の商品情報を追記する（フラグ不要でそのまま有効）。
 * デモでサンプルを見せたい場合のみ VITE_ENABLE_SAMPLE_PRODUCT_META=true（サーバは ENABLE_SAMPLE_PRODUCT_META=true）。
 *
 * 本モジュールはクライアント（App.tsx）とサーバ（lib/gemini.ts → api/agent.ts）の両方から読まれるため、
 * import.meta.env / process.env のどちらが無い環境でも落ちないように両方を握りつぶして読む。
 */
function sampleProductMetaEnabled(): boolean {
  try {
    const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (viteEnv?.VITE_ENABLE_SAMPLE_PRODUCT_META === 'true') return true;
  } catch {
    /* import.meta.env が無い実行環境（Node の一部）では無視 */
  }
  try {
    if (typeof process !== 'undefined' && process.env?.ENABLE_SAMPLE_PRODUCT_META === 'true') return true;
  } catch {
    /* process が無い実行環境（ブラウザ）では無視 */
  }
  return false;
}

const SAMPLE_META_ENABLED = sampleProductMetaEnabled();

/** カタログの一意ID（または Cloudinary public_id）で照合（最優先）。実データはここへ追記する。 */
const BY_ID: Record<string, FurnitureProductMeta> = {
  // 例: '3d_assets/sofa_navy': { brand: '…', modelNumber: '…', price: 128000, productUrl: 'https://…' },
};

/** ファイル名（catalog.json / Cloudinary filename）で照合。下記はローカル同梱モデルの動作確認用ダミー。 */
const BY_NAME: Record<string, FurnitureProductMeta> = {
  chair_1: { brand: '株式会社サンプル家具', modelNumber: 'SMPL-CH-001', price: 24800, productUrl: 'https://example.com/products/chair-1' },
  chair_2: { brand: '株式会社サンプル家具', modelNumber: 'SMPL-CH-002', price: 29800, productUrl: 'https://example.com/products/chair-2' },
  chair_3: { brand: '株式会社サンプル家具', modelNumber: 'SMPL-CH-003', price: 34800, productUrl: 'https://example.com/products/chair-3' },
  floor_lamp_1: { brand: 'サンプル照明', modelNumber: 'SMPL-LP-001', price: 15800, productUrl: 'https://example.com/products/floor-lamp-1' },
  floor_lamp_2: { brand: 'サンプル照明', modelNumber: 'SMPL-LP-002', price: 18800, productUrl: 'https://example.com/products/floor-lamp-2' },
};

/**
 * カテゴリ（type）単位の既定。個別（id/name）が無いときのフォールバック。
 * 本番では家具カタログは Cloudinary 由来のため、ローカル同梱モデル(BY_NAME)は表示されない。そこで
 * 「どの家具を置いても見積もりに自動反映される」動作確認用として、主要カテゴリにダミー値を入れてある。
 * カテゴリ共通のためブランド/品番/URLはあくまで雛形——実運用では各商品を BY_NAME/BY_ID に登録して上書きするか、
 * 本番投入前にこの BY_TYPE を削除/実データ化する。type は api/furniture（Cloudinary）の推定カテゴリ名に準拠。
 */
const BY_TYPE: Record<string, FurnitureProductMeta> = {
  Sofa: { brand: '（例）サンプル・ファニチャー', modelNumber: 'SAMPLE-SOFA', price: 128000, productUrl: 'https://example.com/products/sofa' },
  Chair: { brand: '（例）サンプル・ファニチャー', modelNumber: 'SAMPLE-CHAIR', price: 24800, productUrl: 'https://example.com/products/chair' },
  Table: { brand: '（例）サンプル・ファニチャー', modelNumber: 'SAMPLE-TABLE', price: 58000, productUrl: 'https://example.com/products/table' },
  Bed: { brand: '（例）サンプル・ファニチャー', modelNumber: 'SAMPLE-BED', price: 98000, productUrl: 'https://example.com/products/bed' },
  Lamp: { brand: '（例）サンプル照明', modelNumber: 'SAMPLE-LAMP', price: 15800, productUrl: 'https://example.com/products/lamp' },
  Storage: { brand: '（例）サンプル・ファニチャー', modelNumber: 'SAMPLE-STRG', price: 45000, productUrl: 'https://example.com/products/storage' },
};

function mergePreferringFirst(metas: (FurnitureProductMeta | undefined)[]): FurnitureProductMeta {
  const out: FurnitureProductMeta = {};
  for (const m of metas) {
    if (!m) continue;
    if (out.brand === undefined && m.brand !== undefined) out.brand = m.brand;
    if (out.modelNumber === undefined && m.modelNumber !== undefined) out.modelNumber = m.modelNumber;
    if (out.price === undefined && m.price !== undefined) out.price = m.price;
    if (out.productUrl === undefined && m.productUrl !== undefined) out.productUrl = m.productUrl;
  }
  return out;
}

/**
 * カタログ家具1点に対応する商品メタを返す（id → name → type の順で照合し、上位優先で各項目を補完）。
 * 一致が無ければ空オブジェクト（=従来どおり見積もりは手動入力）。
 */
export function getFurnitureProductMeta(
  item: Pick<FurnitureCatalogItem, 'id' | 'name' | 'type'>
): FurnitureProductMeta {
  // BY_ID は実データ運用の置き場なので常に有効。BY_NAME / BY_TYPE はサンプル値なので既定では引かない
  // （260728 #8: 実在しない品番・example.com のURLが見積とエージェント提案へ流れ込むのを止める）。
  if (!SAMPLE_META_ENABLED) return mergePreferringFirst([BY_ID[item.id]]);
  return mergePreferringFirst([BY_ID[item.id], BY_NAME[item.name], BY_TYPE[item.type]]);
}
