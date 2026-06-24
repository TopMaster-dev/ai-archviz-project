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
 * 暗黙的フィードバックのシグナル別の重み（正の大きさ＝強さ。向きは verdict が表す・260625）。
 * 「重み付きシグナル」の単一の真実。集約 SQL は good を +weight、bad を -weight として扱う。
 */
export const SIGNAL_WEIGHTS: Record<string, number> = {
  export: 1.0, // 強い good: 書き出し＝採用とみなす
  regenerate: 0.5, // 弱い bad: 前版を破棄して再生成（完全否定ではない）
  delete: 1.0, // 強い bad: 生成結果を明示的に削除
};

/**
 * 暗黙的フィードバック（再生成・保存・削除等の自然な操作）を good/bad の【重み付き】シグナルとして
 * システム裏側で自動記録する（260625・インコンテキスト学習基盤）。
 *  - 重みは prompt_context.weight に埋め込む（jsonb・マイグレーション不要・既存集約は欠損時 1.0 既定）。
 *  - in-context 反映用に styleMemo も併せて残す（夜間 aggregate_learned_hints が good を加点 / bad を減点）。
 *  - recordAiFeedback 経由のためゲスト/未ログインは自動で no-op（ベストエフォート・UI を妨げない）。
 */
export async function recordImplicitFeedback(
  signal: 'export' | 'regenerate' | 'delete' | (string & {}),
  opts: {
    verdict: 'good' | 'bad';
    imageRef?: string | null;
    projectId?: string | null;
    styleMemo?: string | null;
    weight?: number;
  },
): Promise<void> {
  const weight = opts.weight ?? SIGNAL_WEIGHTS[signal] ?? 1.0;
  const promptContext: Record<string, unknown> = { implicit: true, signal, weight };
  const memo = opts.styleMemo?.trim();
  if (memo) promptContext.styleMemo = memo;
  return recordAiFeedback({
    verdict: opts.verdict,
    imageRef: opts.imageRef ?? null,
    projectId: opts.projectId ?? null,
    feature: 'ai_design',
    promptContext,
  });
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

/**
 * 全ユーザー共通の「学習ヒント」プール（管理表 row 211/219・Plan A「全体浸透」）を score 降順で返す。
 * 夜間バッチ aggregate_learned_hints() が、複数ユーザーにまたがって good 評価された短い意匠フレーズ（styleMemo）を
 * 匿名・集約したもの。個人の getRecentGoodHints とは別に、全ユーザーの生成プロンプトへ in-context で差し込む。
 * RLS の SELECT は authenticated（全員可・全体浸透のため）。ベストエフォート（未構成/未ログインは空配列）。
 */
export async function getGlobalLearnedHints(limit = 5): Promise<string[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data: userData } = await sb.auth.getUser();
  if (!userData.user?.id) return []; // RLS: authenticated のみ読み取り可
  const { data, error } = await sb
    .from('ai_learned_hints')
    .select('hint')
    .order('score', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const out: string[] = [];
  for (const row of data as Array<{ hint: string | null }>) {
    const text = (row.hint ?? '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * 生成プロンプトへ差し込む学習ヒントを取得する（管理表 row 211/219）。
 * 個人の高評価傾向（優先）＋ 全体共有プール をマージし、重複排除して上位 limit 件。
 * いずれもベストエフォート（取得失敗は空配列扱い）。
 */
export async function getLearnedHints(limit = 5): Promise<string[]> {
  const [mine, shared] = await Promise.all([
    getRecentGoodHints(limit).catch(() => [] as string[]),
    getGlobalLearnedHints(limit).catch(() => [] as string[]),
  ]);
  const out: string[] = [];
  for (const h of [...mine, ...shared]) {
    const text = h.trim();
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}
