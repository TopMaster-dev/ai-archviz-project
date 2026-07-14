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
