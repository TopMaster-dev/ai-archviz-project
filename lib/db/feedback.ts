import { getSupabase } from './supabaseClient.js';

/**
 * AI生成画像の評価（good/bad）を ai_feedback_events に記録する（管理表 row 209/215）。
 *
 * ベストエフォート方針:
 *  - Supabase 未構成（ゲストモード）や未ログイン時は何もしない（UI操作は妨げない）。
 *  - RLS の INSERT ポリシーは with check (auth.uid() = user_id) のため、
 *    user_id にはログイン中ユーザーの id を入れる（null 不可）。project_id は任意（null可）。
 *  - 夜間の aggregate_ai_feedback() は feature ごとに good/bad を集計する。
 */
export async function recordAiFeedback(opts: {
  verdict: 'good' | 'bad';
  imageRef?: string | null;
  projectId?: string | null;
  feature?: string;
  promptContext?: Record<string, unknown> | null;
}): Promise<void> {
  const sb = getSupabase();
  if (!sb) return; // 未構成（ゲスト）: 記録しない
  const { data: userData } = await sb.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return; // 未ログイン: RLS（user_id = auth.uid()）を満たせないため記録しない
  const { error } = await sb.from('ai_feedback_events').insert({
    user_id: uid,
    project_id: opts.projectId ?? null,
    feature: opts.feature ?? 'ai_design',
    verdict: opts.verdict,
    image_ref: opts.imageRef ?? null,
    prompt_context: opts.promptContext ?? null,
  });
  if (error) throw error;
}

/**
 * ユーザー自身が過去に「good」評価した生成の傾向（styleMemo）を新しい順に返す（管理表 row 211/219）。
 * フェーズ1のin-context反映（各ユーザー個別）に使用。次回生成プロンプトへ参考として差し込む。
 * RLS の SELECT は本人の行のみ（auth.uid()=user_id）。ベストエフォート（未構成/未ログインは空配列）。
 */
export async function getRecentGoodHints(limit = 5): Promise<string[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data: userData } = await sb.auth.getUser();
  if (!userData.user?.id) return [];
  const { data, error } = await sb
    .from('ai_feedback_events')
    .select('prompt_context')
    .eq('verdict', 'good')
    .order('created_at', { ascending: false })
    .limit(40);
  if (error || !data) return [];
  const hints: string[] = [];
  for (const row of data as Array<{ prompt_context: { styleMemo?: unknown } | null }>) {
    const memo = row.prompt_context?.styleMemo;
    const text = typeof memo === 'string' ? memo.trim() : '';
    if (text && !hints.includes(text)) hints.push(text);
    if (hints.length >= limit) break;
  }
  return hints;
}
