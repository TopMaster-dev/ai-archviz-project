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

/** ai_usage_events を集計する（直近分・上限つき）。管理者のみが呼ぶ前提。 */
export async function getUsageSummary(limit = 10000): Promise<UsageSummary> {
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
  const { data, error } = await sb
    .from('ai_usage_events')
    .select('user_id, project_id, feature, model, image_count, input_tokens, output_tokens, total_tokens')
    .order('created_at', { ascending: false })
    .limit(limit);
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
  return {
    ok: true,
    totalEvents: rows.length,
    totalCostUsd,
    byModel: topN(byModel, 50),
    byUser: topN(byUser, 50),
    byProject: topN(byProject, 50),
    note:
      'Gemini（BYOK）の費用は「回数×概算単価」の推定です。専用エンジン（Replicate）は概算単価×回数。実請求は各プロバイダが正。',
  };
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
  status: string;
  deviceUa: string | null;
  deviceScreen: string | null;
  ip: string | null;
  createdAt: string | null;
}

interface RegRequestRow {
  id: string;
  email: string;
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
    .select('id, email, status, device_ua, device_screen, ip, created_at')
    .eq('status', st)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return { ok: false, reason: error.message };
  const requests = ((data ?? []) as RegRequestRow[]).map((r) => ({
    id: r.id,
    email: r.email,
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
