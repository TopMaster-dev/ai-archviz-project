import { createClient } from '@supabase/supabase-js';
import { parseAdminEmails, isAdminEmail } from '../admin/adminAuth.js';
import { estimateEventCostUsd, hasKnownPrice } from '../admin/aiPricing.js';

/**
 * 管理ダッシュボードのサーバー中核（260711・**service_role 使用のためクライアントから import 禁止**）。
 * - verifyAdmin: ログイン中ユーザーの access token を検証し、検証済みメールを ADMIN_EMAILS 許可リストと突き合わせる。
 * - getKeyHealth: サービス側 AI キー（Gemini サービスキー / Eraser=Replicate）の「設定有無＋末尾4桁マスク」を返す。
 *   ※ キーの実値は絶対に返さない（プランA=値は env のまま・ダッシュボードは状態のみ）。
 * - getUsageSummary: ai_usage_events を集計し、モデル別/ユーザー別/案件別の回数・トークン・概算費用を返す。
 */

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type AdminAuthResult =
  | { ok: true; email: string; userId: string }
  | { ok: false; status: number; error: string };

/** access token（Bearer）を検証し、許可リストに含まれる管理者か判定する。 */
export async function verifyAdmin(token: string | undefined | null): Promise<AdminAuthResult> {
  if (!token) return { ok: false, status: 401, error: 'Unauthorized' };
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: 'server-not-configured' };
  const allowlist = parseAdminEmails(process.env.ADMIN_EMAILS);
  if (allowlist.length === 0) return { ok: false, status: 403, error: 'admin-not-configured' };
  try {
    const { data, error } = await sb.auth.getUser(token);
    const email = data?.user?.email ?? '';
    const userId = data?.user?.id ?? '';
    if (error || !userId) return { ok: false, status: 401, error: 'Unauthorized' };
    if (!isAdminEmail(email, allowlist)) return { ok: false, status: 403, error: 'Forbidden' };
    return { ok: true, email, userId };
  } catch {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
}

// ---- キーヘルス（プランA: 値は返さず、設定有無とマスクのみ）----

function maskTail(v: string | undefined): { configured: boolean; masked: string } {
  if (!v) return { configured: false, masked: '未設定' };
  const tail = v.length >= 4 ? v.slice(-4) : '••';
  return { configured: true, masked: `••••${tail}` };
}

export interface KeyHealthItem {
  id: string;
  label: string;
  envVar: string;
  configured: boolean;
  masked: string;
  /** 誰が支払うか（説明表示用）。 */
  billing: 'user-byok' | 'operator';
  note?: string;
}

/** サービス側 AI キーの状態一覧（実値は含めない）。 */
export function getKeyHealth(): KeyHealthItem[] {
  const geminiService = process.env.GEMINI_API_KEY;
  const viteGemini = process.env.VITE_GEMINI_API_KEY;
  const items: KeyHealthItem[] = [
    {
      id: 'gemini-service',
      label: 'Gemini サービスキー（フォールバック）',
      envVar: 'GEMINI_API_KEY',
      billing: 'user-byok',
      note: '通常はユーザー各自のキー（BYOK）を使用。これは未設定ユーザー向けのフォールバック。',
      ...maskTail(geminiService),
    },
  ];
  // VITE_ 接頭辞のキーはクライアントへ露出しうるので、設定されていたら警告表示する。
  if (viteGemini) {
    items.push({
      id: 'gemini-vite-warning',
      label: '⚠ VITE_GEMINI_API_KEY（クライアント露出の恐れ）',
      envVar: 'VITE_GEMINI_API_KEY',
      billing: 'operator',
      note: 'VITE_ 接頭辞はクライアントバンドルへ露出しうる。サービスキーは GEMINI_API_KEY（非VITE_）へ移すこと。',
      ...maskTail(viteGemini),
    });
  }
  return items;
}

// ---- キーの疎通テスト（無料の検証エンドポイントを叩く・実値は返さない）----

export interface KeyTestResult {
  engine: string;
  configured: boolean;
  valid: boolean;
  detail: string;
}

/** サービス側キーの有効性を、無料の検証呼び出しで確認する（管理者のみが呼ぶ前提）。 */
export async function testKey(engine: 'gemini' | 'replicate'): Promise<KeyTestResult> {
  if (engine === 'gemini') {
    const key = process.env.GEMINI_API_KEY || '';
    if (!key) return { engine, configured: false, valid: false, detail: '未設定' };
    try {
      // モデル一覧は無料・副作用なし。キーが有効なら 200。
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      );
      return { engine, configured: true, valid: res.ok, detail: res.ok ? '有効' : `無効 (HTTP ${res.status})` };
    } catch {
      return { engine, configured: true, valid: false, detail: '通信エラー' };
    }
  }
  // replicate（実呼び出しと同じく trim 済みのキーで検証する＝前後の空白/改行による偽陰性を防ぐ）。
  const key = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (!key) return { engine, configured: false, valid: false, detail: '未設定' };
  try {
    // アカウント情報取得は無料・副作用なし。
    const res = await fetch('https://api.replicate.com/v1/account', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return { engine, configured: true, valid: res.ok, detail: res.ok ? '有効' : `無効 (HTTP ${res.status})` };
  } catch {
    return { engine, configured: true, valid: false, detail: '通信エラー' };
  }
}

// ---- 利用状況の集計 ----

interface UsageRow {
  user_id: string | null;
  project_id: string | null;
  feature: string | null;
  model: string | null;
  image_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

interface GroupAgg {
  key: string;
  /** 主表示名。ユーザー別＝email/表示名、案件別＝プロジェクト名。key は id のまま（ドリルダウン/共有に使う）。 */
  label?: string;
  /** 副表示（案件別のみ＝作成ユーザーの email/表示名）。 */
  sublabel?: string;
  events: number;
  images: number;
  tokens: number;
  costUsd: number;
  costEstimated: boolean; // 単価不明の行が混ざるか
}

function addTo(map: Map<string, GroupAgg>, key: string, row: UsageRow, cost: number): void {
  const g = map.get(key) ?? { key, events: 0, images: 0, tokens: 0, costUsd: 0, costEstimated: false };
  g.events += 1;
  g.images += Math.max(0, row.image_count ?? 0);
  g.tokens += Math.max(0, row.total_tokens ?? 0);
  g.costUsd += cost;
  if (!hasKnownPrice(row.model)) g.costEstimated = true;
  map.set(key, g);
}

const topN = (map: Map<string, GroupAgg>, n: number): GroupAgg[] =>
  [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.events - a.events).slice(0, n);

export interface UsageSummary {
  ok: boolean;
  reason?: string;
  totalEvents: number;
  totalCostUsd: number;
  byModel: GroupAgg[];
  byUser: GroupAgg[];
  byProject: GroupAgg[];
  note: string;
}

/** 集計・履歴で数える最大イベント件数（直近分の窓）。両者を同じ値にして合計が食い違わないようにする。 */
const USAGE_SUMMARY_MAX_ROWS = 10000;

/** ISO 日時として妥当なら返す（不正は null＝フィルタ無効）。UI からの from/to をそのまま使わないための健全化。 */
function toIsoOrNull(v: string | null | undefined): string | null {
  if (!v || !String(v).trim()) return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** ユーザーID群 → 表示名（email 優先・無ければ表示名）を引く（admin_user_status ビュー・service_role）。 */
async function resolveUserLabels(
  sb: ReturnType<typeof supabaseAdmin>,
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = userIds.filter((id) => id && id !== '(不明)');
  if (!sb || ids.length === 0) return map;
  const { data } = await sb.from('admin_user_status').select('id, email, display_name').in('id', ids);
  for (const p of (data ?? []) as { id: string; email: string | null; display_name: string | null }[]) {
    const label = (p.email || '').trim() || (p.display_name || '').trim();
    if (label) map.set(p.id, label);
  }
  return map;
}

/** 案件ID群 → { プロジェクト名, 作成ユーザー表示名 } を引く（③④・projects + admin_user_status）。 */
async function resolveProjectLabels(
  sb: ReturnType<typeof supabaseAdmin>,
  projectIds: string[],
): Promise<Map<string, { name: string; owner: string | null }>> {
  const map = new Map<string, { name: string; owner: string | null }>();
  const ids = projectIds.filter((id) => id && id !== '(なし)');
  if (!sb || ids.length === 0) return map;
  const { data } = await sb.from('projects').select('id, name, owner_id').in('id', ids);
  const rows = (data ?? []) as { id: string; name: string | null; owner_id: string | null }[];
  const ownerIds = [...new Set(rows.map((r) => r.owner_id).filter((v): v is string => !!v))];
  const ownerLabels = await resolveUserLabels(sb, ownerIds);
  for (const r of rows) {
    map.set(r.id, {
      name: (r.name || '').trim() || '(名称未設定)',
      owner: (r.owner_id && ownerLabels.get(r.owner_id)) || null,
    });
  }
  return map;
}

/** ai_usage_events を集計する（直近分・上限つき・任意の期間フィルタ）。管理者のみが呼ぶ前提。 */
export async function getUsageSummary(opts?: {
  limit?: number;
  from?: string | null;
  to?: string | null;
}): Promise<UsageSummary> {
  const limit = Math.min(50000, Math.max(1, opts?.limit ?? USAGE_SUMMARY_MAX_ROWS));
  const empty: UsageSummary = {
    ok: false,
    totalEvents: 0,
    totalCostUsd: 0,
    byModel: [],
    byUser: [],
    byProject: [],
    note: '',
  };
  const sb = supabaseAdmin();
  if (!sb) return { ...empty, reason: 'server-not-configured' };
  const from = toIsoOrNull(opts?.from);
  const to = toIsoOrNull(opts?.to);
  let q = sb
    .from('ai_usage_events')
    .select('user_id, project_id, feature, model, image_count, input_tokens, output_tokens, total_tokens')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);
  const { data, error } = await q;
  if (error) return { ...empty, reason: error.message };
  const rows = (data ?? []) as UsageRow[];

  const byModel = new Map<string, GroupAgg>();
  const byUser = new Map<string, GroupAgg>();
  const byProject = new Map<string, GroupAgg>();
  let totalCostUsd = 0;
  for (const row of rows) {
    const cost = estimateEventCostUsd({
      model: row.model,
      imageCount: row.image_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    });
    totalCostUsd += cost;
    addTo(byModel, row.model || '(不明)', row, cost);
    addTo(byUser, row.user_id || '(不明)', row, cost);
    addTo(byProject, row.project_id || '(なし)', row, cost);
  }
  const byUserTop = topN(byUser, 50);
  // ユーザー別は UUID のままでは誰か分からないので email/表示名を付ける（G1）。key は user_id のまま＝ドリルダウンに使う。
  const labels = await resolveUserLabels(sb, byUserTop.map((g) => g.key));
  for (const g of byUserTop) {
    const lbl = labels.get(g.key);
    if (lbl) g.label = lbl;
  }
  // 案件別は project_id を「プロジェクト名（作成ユーザー）」に解決する（③④）。key は project_id のまま＝1クリック閲覧に使う。
  const byProjectTop = topN(byProject, 50);
  const projLabels = await resolveProjectLabels(sb, byProjectTop.map((g) => g.key));
  for (const g of byProjectTop) {
    const pl = projLabels.get(g.key);
    if (pl) {
      g.label = pl.name;
      g.sublabel = pl.owner ?? undefined;
    }
  }
  return {
    ok: true,
    totalEvents: rows.length,
    totalCostUsd,
    byModel: topN(byModel, 50),
    byUser: byUserTop,
    byProject: byProjectTop,
    note:
      'Gemini（BYOK）の費用は実測トークン×公式単価の推定です（入力$2/1M・画像出力$120/1M 等）。専用エンジンは暫定単価×回数。実請求は各プロバイダが正。',
  };
}

// ---- ユーザー別の利用履歴（ドリルダウン・G2）----

export interface UsageEvent {
  createdAt: string | null;
  feature: string | null;
  model: string | null;
  images: number;
  tokens: number;
  costUsd: number;
  costEstimated: boolean;
}

export interface UserUsageResult {
  ok: boolean;
  reason?: string;
  user: { id: string; email: string | null; displayName: string | null };
  events: UsageEvent[];
  totalEvents: number;
  totalCostUsd: number;
}

/** 1ユーザーの AI 利用履歴（イベント一覧＋合計費用）。任意の期間フィルタ。管理者のみが呼ぶ前提。 */
export async function getUserUsageHistory(
  userId: string,
  opts?: { from?: string | null; to?: string | null; limit?: number },
): Promise<UserUsageResult> {
  const id = (userId || '').trim();
  const base = { user: { id, email: null, displayName: null }, events: [] as UsageEvent[], totalEvents: 0, totalCostUsd: 0 };
  if (!id) return { ok: false, reason: 'user-required', ...base };
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: 'server-not-configured', ...base };
  // 表示は最新 displayLimit 件だが、合計（件数・費用）は集計側と同じ窓（USAGE_SUMMARY_MAX_ROWS）で数える。
  // ＝ユーザー行の合計とドリルダウンの合計が食い違わない（表示件数だけを絞る）。
  const displayLimit = Math.min(2000, Math.max(1, opts?.limit ?? 500));
  const from = toIsoOrNull(opts?.from);
  const to = toIsoOrNull(opts?.to);
  let q = sb
    .from('ai_usage_events')
    .select('created_at, feature, model, image_count, input_tokens, output_tokens, total_tokens')
    .eq('user_id', id)
    .order('created_at', { ascending: false })
    .limit(USAGE_SUMMARY_MAX_ROWS);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);
  const { data, error } = await q;
  if (error) return { ok: false, reason: error.message, ...base };
  const rows = (data ?? []) as {
    created_at: string | null;
    feature: string | null;
    model: string | null;
    image_count: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
  }[];
  // 合計はウィンドウ内の全件で算出（集計側と一致）。
  let totalCostUsd = 0;
  for (const r of rows) {
    totalCostUsd += estimateEventCostUsd({
      model: r.model,
      imageCount: r.image_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    });
  }
  const totalEvents = rows.length;
  // 一覧表示は最新 displayLimit 件のみ（トークン従量で算出＝集計側と同一の estimateEventCostUsd）。
  const events: UsageEvent[] = rows.slice(0, displayLimit).map((r) => ({
    createdAt: r.created_at,
    feature: r.feature,
    model: r.model,
    images: Math.max(0, r.image_count ?? 0),
    tokens: Math.max(0, r.total_tokens ?? 0),
    costUsd: estimateEventCostUsd({
      model: r.model,
      imageCount: r.image_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    }),
    costEstimated: !hasKnownPrice(r.model),
  }));
  // 表示用に email/表示名を引く（PII・管理者のみ）。
  let email: string | null = null;
  let displayName: string | null = null;
  const { data: prof } = await sb.from('admin_user_status').select('id, email, display_name').eq('id', id).limit(1);
  const p = (prof ?? [])[0] as { id: string; email: string | null; display_name: string | null } | undefined;
  if (p) {
    email = p.email;
    displayName = p.display_name;
  }
  return { ok: true, user: { id, email, displayName }, events, totalEvents, totalCostUsd };
}

// ---- 案件を運営が1クリックで閲覧（⑤・既存の ?share= 読み取り専用ビューアを再利用）----

export type ProjectShareResult =
  | { ok: true; token: string; reused: boolean }
  | { ok: false; reason: string };

/**
 * 対象プロジェクトの閲覧用トークンを取得（無ければ発行）。運営が共有機能を使わずに該当案件を開くための土台。
 * 既存の有効な共有トークン（未失効・未期限切れ・view）があれば再利用し、無ければ管理者名義で1件作成する。
 * service_role なので RLS を跨いで任意ユーザーの案件に対して発行できる（管理者のみ到達・読み取り専用）。
 */
export async function createOrGetProjectShareToken(
  projectId: string,
  adminUserId: string,
): Promise<ProjectShareResult> {
  const pid = (projectId || '').trim();
  if (!pid) return { ok: false, reason: 'project-required' };
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: 'server-not-configured' };
  // 対象案件の存在（未削除）を確認。存在しなければ発行しない。
  const { data: proj, error: pErr } = await sb
    .from('projects')
    .select('id')
    .eq('id', pid)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (pErr) return { ok: false, reason: pErr.message };
  if (!proj) return { ok: false, reason: 'not-found' };
  // 既存の有効トークンを再利用（行の増殖を避ける）。未失効・未期限切れ・view のみ。
  const nowIso = new Date().toISOString();
  const { data: existing } = await sb
    .from('project_shares')
    .select('token, expires_at')
    .eq('project_id', pid)
    .eq('revoked', false)
    .eq('permission', 'view')
    .order('created_at', { ascending: false })
    .limit(10);
  const live = ((existing ?? []) as { token: string; expires_at: string | null }[]).find(
    (s) => !s.expires_at || s.expires_at > nowIso,
  );
  if (live?.token) return { ok: true, token: live.token, reused: true };
  // 無ければ管理者名義で新規発行（token は既定でランダム生成）。
  // 運営が閲覧するための一時トークンなので短い有効期限を付け、公開リンクが恒久的に残らないようにする
  // （閲覧はその場で開く用途・再度「開く」で自動再発行。所有者に不可視・失効不能な恒久トークンを残さない）。
  const expiresIso = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1時間で失効
  const { data: ins, error: insErr } = await sb
    .from('project_shares')
    .insert({ project_id: pid, created_by: adminUserId, permission: 'view', expires_at: expiresIso })
    .select('token')
    .single();
  if (insErr) return { ok: false, reason: insErr.message };
  return { ok: true, token: (ins as { token: string }).token, reused: false };
}

// ---- ユーザーの猶予期間（フリープラン=AIクレジット期限）管理（#4・260715）----
// 運営ダッシュボードから対象ユーザーの ai_credits_expires_at（＝フリープランの猶予期限）を延長/失効させる。
// いずれも service_role でのみ実行（クライアントは api 経由・verifyAdmin 済みでのみ到達）。

export interface UserStatus {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
  plan: string | null;
  aiCreditsTotal: number;
  aiCreditsUsed: number;
  aiCreditsRemaining: number;
  /** フリープラン猶予期限（AIクレジット失効時刻）。null=無期限/未設定。 */
  graceExpiresAt: string | null;
  /** 猶予期限が現在時刻を過ぎているか（＝フリープラン制限が発動する状態）。 */
  graceExpired: boolean;
  lockedAt: string | null;
  lockReason: string | null;
  registeredAt: string | null;
  createdAt: string | null;
}

interface AdminUserStatusRow {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string | null;
  plan: string | null;
  ai_credits_total: number | null;
  ai_credits_used: number | null;
  ai_credits_expires_at: string | null;
  locked_at: string | null;
  lock_reason: string | null;
  registered_at: string | null;
  created_at: string | null;
}

function toUserStatus(r: AdminUserStatusRow): UserStatus {
  const total = Math.max(0, r.ai_credits_total ?? 0);
  const used = Math.max(0, r.ai_credits_used ?? 0);
  const exp = r.ai_credits_expires_at;
  const graceExpired = !!exp && new Date(exp).getTime() <= Date.now();
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    plan: r.plan,
    aiCreditsTotal: total,
    aiCreditsUsed: used,
    aiCreditsRemaining: Math.max(0, total - used),
    graceExpiresAt: exp,
    graceExpired,
    lockedAt: r.locked_at,
    lockReason: r.lock_reason,
    registeredAt: r.registered_at,
    createdAt: r.created_at,
  };
}

export type UserStatusResult =
  | { ok: true; status: UserStatus }
  | { ok: false; reason: string };

const ADMIN_STATUS_COLS =
  'id, email, display_name, role, plan, ai_credits_total, ai_credits_used, ai_credits_expires_at, locked_at, lock_reason, registered_at, created_at';

/** メールでユーザーの状態（プラン・クレジット・猶予期限・ロック）を引く（大小文字を無視）。 */
export async function findUserStatusByEmail(email: string): Promise<UserStatusResult> {
  const trimmed = (email || '').trim();
  if (!trimmed) return { ok: false, reason: 'email-required' };
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: 'server-not-configured' };
  // ilike のワイルドカード（_ % \）をエスケープして完全一致（大小文字無視）にする。
  // メールの local part に含まれ得る '_' を放置すると別ユーザーに誤ヒットし、誤ったアカウントを
  // 更新してしまう（260715 検証で確定）。念のため取得後にも厳密一致を確認する。
  const escaped = trimmed.replace(/([\\%_])/g, '\\$1');
  const { data, error } = await sb
    .from('admin_user_status')
    .select(ADMIN_STATUS_COLS)
    .ilike('email', escaped)
    .limit(2);
  if (error) return { ok: false, reason: error.message };
  const rows = (data ?? []) as AdminUserStatusRow[];
  const row = rows.find((r) => (r.email ?? '').trim().toLowerCase() === trimmed.toLowerCase());
  if (!row) return { ok: false, reason: 'not-found' };
  return { ok: true, status: toUserStatus(row) };
}

export interface SetGraceInput {
  userId: string;
  /** 新しい猶予期限（ISO8601）。null/空 = 失効させない場合はそのまま。「今すぐ失効」は過去日時（=now）を渡す。 */
  expiresAt: string | null;
  /** true のとき AIクレジットを満タンに戻す（used=0・total を最低50に）。 */
  resetCredits?: boolean;
}

/** 対象ユーザーの猶予期限（ai_credits_expires_at）を設定し、任意でクレジットをリセットする。更新後の状態を返す。 */
export async function setUserGrace(input: SetGraceInput): Promise<UserStatusResult> {
  const userId = (input.userId || '').trim();
  if (!userId) return { ok: false, reason: 'user-required' };
  // expiresAt は妥当な日時のみ許可（不正な文字列で列を壊さない）。
  let expiresIso: string | null = null;
  if (input.expiresAt != null && String(input.expiresAt).trim() !== '') {
    const t = new Date(String(input.expiresAt)).getTime();
    if (!Number.isFinite(t)) return { ok: false, reason: 'invalid-date' };
    expiresIso = new Date(t).toISOString();
  }
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: 'server-not-configured' };
  const patch: Record<string, unknown> = { ai_credits_expires_at: expiresIso };
  if (input.resetCredits) {
    patch.ai_credits_used = 0;
    patch.ai_credits_total = 50;
  }
  const { error } = await sb.from('profiles').update(patch).eq('id', userId);
  if (error) return { ok: false, reason: error.message };
  // 更新後の状態を返す（id で引き直す）。
  const { data, error: e2 } = await sb
    .from('admin_user_status')
    .select(ADMIN_STATUS_COLS)
    .eq('id', userId)
    .limit(1);
  if (e2) return { ok: false, reason: e2.message };
  const row = (data ?? [])[0] as AdminUserStatusRow | undefined;
  if (!row) return { ok: false, reason: 'not-found' };
  return { ok: true, status: toUserStatus(row) };
}

// ---- 登録リクエストの運営管理（#2 再設計・260716）----
// 招待制を維持したまま、利用希望者の「登録リクエスト」を一覧・承認（招待リンク送信）・却下する。

export interface RegistrationRequestItem {
  id: string;
  email: string;
  name: string | null;
  status: string;
  deviceUa: string | null;
  deviceScreen: string | null;
  ip: string | null;
  createdAt: string | null;
}

interface RegRequestRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  device_ua: string | null;
  device_screen: string | null;
  ip: string | null;
  created_at: string | null;
}

/** 登録リクエスト一覧（既定は未処理 pending）。 */
export async function listRegistrationRequests(
  status = 'pending',
): Promise<{ ok: boolean; requests?: RegistrationRequestItem[]; reason?: string }> {
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: 'server-not-configured' };
  const st = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
  const { data, error } = await sb
    .from('registration_requests')
    .select('id, email, name, status, device_ua, device_screen, ip, created_at')
    .eq('status', st)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return { ok: false, reason: error.message };
  const requests = ((data ?? []) as RegRequestRow[]).map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    status: r.status,
    deviceUa: r.device_ua,
    deviceScreen: r.device_screen,
    ip: r.ip,
    createdAt: r.created_at,
  }));
  return { ok: true, requests };
}

/** リクエストを承認し、招待メール（リンク）を送信する。auth.users を作成し、本登録フローへ誘導する。 */
export async function approveRegistrationRequest(
  requestId: string,
  adminUserId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const id = (requestId || '').trim();
  if (!id) return { ok: false, reason: 'id-required' };
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: 'server-not-configured' };
  const { data: reqRow, error: rErr } = await sb
    .from('registration_requests')
    .select('id, email, status')
    .eq('id', id)
    .limit(1)
    .maybeSingle();
  if (rErr) return { ok: false, reason: rErr.message };
  if (!reqRow) return { ok: false, reason: 'not-found' };
  if (reqRow.status !== 'pending') return { ok: false, reason: 'already-decided' };
  const email = (reqRow.email || '').trim();
  if (!email) return { ok: false, reason: 'invalid-email' };
  // 招待リンク送信（auth.users 作成＋メール送信）。redirectTo 未指定なら Supabase の Site URL が使われる。
  const redirectTo = process.env.PUBLIC_APP_URL || process.env.APP_URL || '';
  const { error: invErr } = await sb.auth.admin.inviteUserByEmail(
    email,
    redirectTo ? { redirectTo } : undefined,
  );
  if (invErr) {
    // 既に招待/登録済みのメールは「招待は成立している」とみなして承認扱いにする（冪等）。
    // 招待成功→ステータス更新失敗で pending が残った場合の再承認や、二重クリックで詰まらないようにする（260716 検証）。
    const m = (invErr.message || '').toLowerCase();
    const code = (invErr as { code?: string }).code || '';
    const alreadyExists =
      code === 'email_exists' || m.includes('already') || m.includes('registered') || m.includes('exists');
    if (!alreadyExists) return { ok: false, reason: invErr.message };
  }
  const { error: upErr } = await sb
    .from('registration_requests')
    .update({ status: 'approved', decided_at: new Date().toISOString(), decided_by: adminUserId })
    .eq('id', id);
  if (upErr) return { ok: false, reason: upErr.message };
  return { ok: true };
}

/** リクエストを却下する（招待は送らない）。 */
export async function rejectRegistrationRequest(
  requestId: string,
  adminUserId: string,
  note?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const id = (requestId || '').trim();
  if (!id) return { ok: false, reason: 'id-required' };
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: 'server-not-configured' };
  const { error } = await sb
    .from('registration_requests')
    .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: adminUserId, note: note ?? null })
    .eq('id', id)
    .eq('status', 'pending');
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
