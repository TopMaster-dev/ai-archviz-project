import type { FurnitureCatalogItem, AgentCatalogEntry, AgentRecommendation } from '../types.js';
import { getFurnitureProductMeta } from './furnitureProductMeta.js';

// AIエージェント（相談）が「実在するカタログ家具」をメーカー/品番/単価/URL付きで提案し、ワンクリックで
// 見積もりへ追加できるようにするための補助（Tier2・260620）。
// 捏造防止のため、エージェントには番号(index)付きのカタログを渡し、返ってきた index をこちら側で
// カタログ実データへ解決する（価格・品番・URL はエージェントの自由記述ではなくカタログ由来を採用）。

const MAX_ENTRIES = 60;

/** 家具カタログ＋商品メタから、エージェントへ渡す重複排除済みの推薦候補リストを作る（価格のある商品のみ）。 */
export function buildAgentCatalog(items: FurnitureCatalogItem[]): AgentCatalogEntry[] {
  const out: AgentCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const meta = getFurnitureProductMeta(item);
    const price = item.price ?? meta.price;
    if (price === undefined) continue; // 価格が無いと見積もり提示にならないので除外
    const entry: AgentCatalogEntry = {
      name: item.name,
      type: item.type,
      brand: item.brand ?? meta.brand,
      modelNumber: item.modelNumber ?? meta.modelNumber,
      price,
      productUrl: item.productUrl ?? meta.productUrl,
    };
    // 同一メタ（カテゴリ既定で全部同じ等）は1件へ集約しトークンを節約。
    const key = `${entry.type}|${entry.brand ?? ''}|${entry.modelNumber ?? ''}|${entry.price}|${entry.productUrl ?? ''}`;
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
