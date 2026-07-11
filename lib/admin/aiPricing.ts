/**
 * AIモデル別の概算単価表とコスト算出（純関数・260711）。管理ダッシュボードの費用表示に使う。
 *
 * 注意（正直な前提）:
 * - Gemini（ユーザーBYOK）は実請求を運営から読めないため「呼び出し回数×概算単価」の**推定**。
 * - 専用エンジン（Replicate 等・運営キー）は1回あたりの概算単価。実請求はプロバイダ側が正。
 * - 単価はドル。導入時に最新値へ更新する前提の目安（2026-07 時点の調査値）。
 */

export interface AiUsageEventLike {
  model?: string | null;
  imageCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface ModelPrice {
  /** 画像1枚あたり（画像生成/編集モデル）。 */
  perImageUsd?: number;
  /** 1回あたり（マスク編集エンジン等）。 */
  perCallUsd?: number;
}

/** モデルID→概算単価（USD）。前方一致で解決する（バージョン差異を吸収）。 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gemini-3-pro-image': { perImageUsd: 0.134 },
  'gemini-2.5-flash-image': { perImageUsd: 0.039 },
  'gemini-2.0-flash': { perImageUsd: 0.039 },
  'replicate:remove-object': { perCallUsd: 0.0006 },
  'replicate:flux-fill-pro': { perCallUsd: 0.05 },
  inpaint: { perCallUsd: 0.05 },
};

/** モデルIDの前方一致で単価を引く（見つからなければ null）。 */
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.trim();
  if (!m) return null;
  if (MODEL_PRICES[m]) return MODEL_PRICES[m];
  for (const key of Object.keys(MODEL_PRICES)) {
    if (m.startsWith(key)) return MODEL_PRICES[key];
  }
  return null;
}

/** 1イベントの概算コスト（USD）。単価不明は 0（＝集計では「不明」として別表示する想定）。 */
export function estimateEventCostUsd(ev: AiUsageEventLike): number {
  const price = priceForModel(ev.model);
  if (!price) return 0;
  const images = Math.max(0, ev.imageCount ?? 0);
  if (price.perCallUsd != null) return price.perCallUsd * Math.max(1, images || 1);
  if (price.perImageUsd != null) return price.perImageUsd * Math.max(1, images || 1);
  return 0;
}

/** 単価が判明しているか（費用が推定表示できるか）。 */
export function hasKnownPrice(model: string | null | undefined): boolean {
  return priceForModel(model) != null;
}
