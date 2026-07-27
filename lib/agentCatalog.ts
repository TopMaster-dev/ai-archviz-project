import type { FurnitureCatalogItem, AgentCatalogEntry, AgentRecommendation } from '../types.js';
import { getFurnitureProductMeta } from './furnitureProductMeta.js';

// AIエージェント（相談）が「実在するカタログ家具」をメーカー/品番/単価/URL付きで提案し、ワンクリックで
// 見積もりへ追加できるようにするための補助（Tier2・260620）。
// 捏造防止のため、エージェントには番号(index)付きのカタログを渡し、返ってきた index をこちら側で
// カタログ実データへ解決する（価格・品番・URL はエージェントの自由記述ではなくカタログ由来を採用）。

const MAX_ENTRIES = 60;

/**
 * プレースホルダ（サンプル）値かどうか。260728 クライアント #8「提案商品が実在しない／URLが404」対策の安全網。
 * getFurnitureProductMeta 側で既定オフにしたうえで、万一サンプル値が混じっても
 * 「実在する商品」として提案カード・見積へ出さないための最終フィルタ。
 */
export function isPlaceholderProductValue(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim();
  if (!s) return false;
  if (/^(SAMPLE|SMPL)[-_]/i.test(s)) return true;
  if (/example\.(com|org|net)/i.test(s)) return true;
  if (s.includes('（例）') || s.includes('サンプル')) return true;
  return false;
}

/** 家具カタログ＋商品メタから、エージェントへ渡す重複排除済みの推薦候補リストを作る（価格のある商品のみ）。 */
export function buildAgentCatalog(items: FurnitureCatalogItem[]): AgentCatalogEntry[] {
  const out: AgentCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const meta = getFurnitureProductMeta(item);
    const price = item.price ?? meta.price;
    // 以前は「価格が無い候補は除外」していたが、サンプル価格を既定オフにした結果（260728 #8）、
    // 価格を持つのはユーザーアップロードだけになり、公式カタログの提案が全滅していた。
    // 実在するカタログ家具を価格なしで提案する方が、架空の品番・価格を出すより有用かつ正直なので残す。
    // 価格未設定は表示側で「価格未入力」となり、ユーザーが実際の金額を入れられる。
    const brand = item.brand ?? meta.brand;
    const modelNumber = item.modelNumber ?? meta.modelNumber;
    const productUrl = item.productUrl ?? meta.productUrl;
    // 商品としての同定情報がプレースホルダなら、その「価格」も架空の数字でしかない。
    // メーカー/品番/URL だけ伏せて価格を残すと、正体不明の金額が提案カードと見積合計に載るため、
    // 候補ごと落とす（260728 #8・敵対レビュー指摘）。
    if (
      isPlaceholderProductValue(brand) ||
      isPlaceholderProductValue(modelNumber) ||
      isPlaceholderProductValue(productUrl)
    ) {
      continue;
    }
    const entry: AgentCatalogEntry = {
      name: item.name,
      type: item.type,
      brand,
      modelNumber,
      price,
      productUrl,
    };
    // 同一メタ（カテゴリ既定で全部同じ等）は1件へ集約しトークンを節約。
    // name を含める: アップロード家具は type が一律「アップロード」で、品番/URL未入力だと
    // 別モデルでもキーが衝突し、2件目以降が落ちて推薦できなくなる（260728 敵対レビュー指摘）。
    const key = `${entry.name}|${entry.type}|${entry.brand ?? ''}|${entry.modelNumber ?? ''}|${entry.price ?? ''}|${entry.productUrl ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * エージェントが返した index ベースの推薦を、カタログ実データ＋理由へ解決する。
 * 価格/品番/URL/ブランドはカタログ由来を採用（捏造防止）。name/reason はエージェントの記述を優先。
 * index がカタログ範囲外のもの（=ハルシネーション）は捨てる。
 */
export function resolveAgentRecommendations(
  catalog: AgentCatalogEntry[],
  picks: { index: number; name?: string; reason?: string }[]
): AgentRecommendation[] {
  const out: AgentRecommendation[] = [];
  for (const pick of picks) {
    const entry = catalog[pick.index];
    if (!entry) continue;
    out.push({
      name: (pick.name ?? '').trim() || entry.name,
      brand: entry.brand,
      modelNumber: entry.modelNumber,
      price: entry.price,
      productUrl: entry.productUrl,
      reason: (pick.reason ?? '').trim() || undefined,
    });
  }
  return out;
}
