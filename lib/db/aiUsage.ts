import { getSupabase } from './supabaseClient.js';

// トークン計測（管理表 row 58）。AI生成ごとのトークン消費を ai_usage_events に記録する土台。
//
// テストマーケ期間中は無効（記録しない）。本番の従量課金（フェーズ2・row 65）準備で有効化する。
// 記録は本人のクライアントから（RLS insert own）。トークン数はサーバ（Gemini usageMetadata）由来。
// ベストエフォート: 失敗しても UI を妨げない（recordAiFeedback と同方針）。
//
// 注: 本「基礎」は計測のためのクライアント記録。RLS により他人へは書けないが、自分の値は理論上偽装し得る。
// 課金に耐える権威ある計測は、運営APIへ切替えるフェーズ2（row 65）でサーバ側に置く前提。
// 260711: 管理ダッシュボード（利用状況・費用）にデータを溜めるため有効化。専用エンジン（Replicate）も
// クライアントから同じ recordAiUsage で model 別に記録される（費用は運営側の単価表 lib/admin/aiPricing で算出）。
export const ENABLE_TOKEN_METERING = true;

export type AiUsageFeature = 'render' | 'ai_edit' | 'ai_coordinate' | 'agent' | 'export';

interface UsageTokens {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

/** AI生成1回のトークン消費を記録する（無効時・ゲスト・未ログインは何もしない）。 */
export async function recordAiUsage(opts: {
  feature: AiUsageFeature;
  usage?: UsageTokens | null;
  model?: string | null;
  imageCount?: number;
  projectId?: string | null;
}): Promise<void> {
  if (!ENABLE_TOKEN_METERING) return;
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data: userData } = await sb.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) return;
    const u = opts.usage ?? null;
    const { error } = await sb.from('ai_usage_events').insert({
      user_id: uid,
      project_id: opts.projectId ?? null,
      feature: opts.feature,
      model: opts.model ?? null,
      input_tokens: u?.promptTokenCount ?? 0,
      output_tokens: u?.candidatesTokenCount ?? 0,
      total_tokens: u?.totalTokenCount ?? 0,
      image_count: opts.imageCount ?? 0,
    });
    if (error) throw error;
  } catch (e) {
    console.warn('[ai usage] 記録に失敗', e);
  }
}
