/**
 * AIモデル別の概算単価表とコスト算出（純関数・260711／260722 トークン従量化）。管理ダッシュボードの費用表示に使う。
 *
 * 注意（正直な前提）:
 * - Gemini（ユーザーBYOK）は実請求を運営から読めないため、公式単価に「実測トークン数」を掛けた**推定**。
 * - 画像生成モデルは **入力トークン×入力単価 ＋ 出力トークン×出力単価** で算出（従来の「画像1枚=固定額」より正確）。
 *   出力トークンには生成画像のトークン（1K/2K画像≒1,120／4K≒2,000）が含まれ、これが費用の主成分になる。
 *   ＝トークン総数が2倍でも、差分の多くが安価な入力トークンなら費用はほぼ同じになる（画像出力が支配的なため）。
 * - 単価はドル。導入時に最新値へ更新する前提の目安。出典: https://ai.google.dev/gemini-api/docs/pricing
 * - 専用エンジン（Replicate/Bria 系）は従量制のため per-call の暫定単価（要実測更新）。
 */

export interface AiUsageEventLike {
  model?: string | null;
  imageCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface ModelPrice {
  /** 入力100万トークンあたり（USD）。トークン従量算出に使う。 */
  inputPerMTok?: number;
  /** 出力100万トークンあたり（USD）。画像出力は高単価、テキスト出力は低単価。 */
  outputPerMTok?: number;
  /** 画像1枚あたり（USD）。トークン数が取れない古い記録のフォールバック。 */
  perImageUsd?: number;
  /** 1回あたり（USD）。マスク編集など専用エンジンの従量フォールバック。 */
  perCallUsd?: number;
  /** 単価が暫定（実測での更新が必要）か。表示で注記する。 */
  provisional?: boolean;
}

/**
 * モデルID→概算単価（USD）。前方一致で解決する（バージョン差異を吸収）。
 * 画像生成モデルは公式のトークン単価（入力$2/1M・画像出力$120/1M）。テキスト（エージェント）は出力$12/1M。
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Gemini 3 Pro Image（Nano Banana Pro）: 入力 $2/1M、画像出力 $120/1M（1K/2K≒$0.134、4K≒$0.24/枚）。
  'gemini-3-pro-image': { inputPerMTok: 2, outputPerMTok: 120, perImageUsd: 0.134 },
  // 旧・軽量画像モデル（トークン単価は未確定のため画像1枚フォールバックを維持）。
  'gemini-2.5-flash-image': { perImageUsd: 0.039 },
  'gemini-2.0-flash-image': { perImageUsd: 0.039 },
  // Gemini 3 Pro（テキスト・エージェント相談）: 入力 $2/1M、テキスト出力 $12/1M。
  'gemini-3-pro': { inputPerMTok: 2, outputPerMTok: 12 },
  // Gemini 2.5 Flash（テキスト・エージェント相談/配置キャプションの既定モデル・lib/gemini.ts）: 入力 $0.30/1M・出力 $2.50/1M。
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-2.0-flash': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  // 専用エンジン（Replicate/Bria 系）: 従量制。per-call の暫定単価（要実測更新）。
  bria: { perCallUsd: 0.01, provisional: true },
  replicate: { perCallUsd: 0.01, provisional: true },
};

/** モデルIDの前方一致で単価を引く（最長一致を優先＝'gemini-3-pro-image' が 'gemini-3-pro' に負けない）。 */
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.trim();
  if (!m) return null;
  if (MODEL_PRICES[m]) return MODEL_PRICES[m];
  let best: { key: string; price: ModelPrice } | null = null;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (m.startsWith(key) && (!best || key.length > best.key.length)) best = { key, price: MODEL_PRICES[key] };
  }
  return best?.price ?? null;
}

/**
 * 1イベントの概算コスト（USD）。単価不明は 0（＝集計では「不明」として別表示する想定）。
 * トークン単価があり実測トークンが取れていれば **トークン従量**（正確）。無ければ画像1枚/1回のフォールバック。
 */
export function estimateEventCostUsd(ev: AiUsageEventLike): number {
  const price = priceForModel(ev.model);
  if (!price) return 0;
  const inTok = Math.max(0, ev.inputTokens ?? 0);
  const outTok = Math.max(0, ev.outputTokens ?? 0);
  const images = Math.max(0, ev.imageCount ?? 0);
  // トークン従量（最優先・実測に基づく）。入力/出力どちらかでもトークンがあれば採用。
  if ((price.inputPerMTok != null || price.outputPerMTok != null) && (inTok > 0 || outTok > 0)) {
    // 画像モデルで出力（生成画像）トークンが欠落している記録は入力だけの過少計上になるため、
    // 画像1枚の単価を下限に使う（費用の主成分＝画像出力を失わない）。
    if (price.perImageUsd != null && outTok === 0) {
      return price.perImageUsd * Math.max(1, images || 1);
    }
    return (inTok * (price.inputPerMTok ?? 0) + outTok * (price.outputPerMTok ?? 0)) / 1_000_000;
  }
  if (price.perCallUsd != null) return price.perCallUsd * Math.max(1, images || 1);
  if (price.perImageUsd != null) return price.perImageUsd * Math.max(1, images || 1);
  return 0;
}

/** 単価が判明しているか（費用が推定表示できるか）。暫定単価は「判明」扱い（別途 provisional で注記）。 */
export function hasKnownPrice(model: string | null | undefined): boolean {
  return priceForModel(model) != null;
}

/** その行の単価が暫定（要実測更新）か。 */
export function isProvisionalPrice(model: string | null | undefined): boolean {
  return priceForModel(model)?.provisional === true;
}
