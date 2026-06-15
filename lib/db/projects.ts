import { getSupabase } from './supabaseClient.js';
import type { ProjectState } from '../project/projectState.js';
import type { ProjectRow, ProjectSummary, SharedProject } from './types.js';

// プロジェクトの永続化（CRUD + 複製 + 共有）。すべて RLS 前提（本人の行のみ）。

const GRACE_DAYS = 14;

/**
 * フリープランのプロジェクト保存上限。
 * DB 側の free_plan_project_limit() と一致させること（schema.sql 参照）。
 * 実際の拒否は INSERT トリガが担うため、これは UI 表示・事前判定用のミラー値。
 * 260613: テストマーケティング期は 5 → 10 に引き上げ（管理表 row 72）。
 */
export const FREE_PLAN_PROJECT_LIMIT = 10;

/** createProject / duplicateProject 等がフリープラン上限トリガで拒否されたかを判定する。 */
export function isFreePlanLimitError(e: unknown): boolean {
  if (!e) return false;
  const m =
    typeof e === 'string'
      ? e
      : typeof (e as { message?: unknown }).message === 'string'
        ? (e as { message: string }).message
        : '';
  return m.includes('FREE_PLAN_LIMIT_REACHED');
}

function requireClient() {
  const sb = getSupabase();
  if (!sb) {
    throw new Error('Supabase が未構成のため、プロジェクトの保存・読み込みは利用できません。');
  }
  return sb;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const sb = requireClient();
  const { data, error } = await sb
    .from('projects')
    .select('id, name, thumbnail_url, updated_at')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProjectSummary[];
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const sb = requireClient();
  const { data, error } = await sb
    .from('projects')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return (data as ProjectRow | null) ?? null;
}

export async function createProject(name: string, data: ProjectState): Promise<string> {
  const sb = requireClient();
  const { data: userData } = await sb.auth.getUser();
  const ownerId = userData.user?.id;
  if (!ownerId) throw new Error('未ログインのためプロジェクトを作成できません。');
  const { data: row, error } = await sb
    .from('projects')
    .insert({ owner_id: ownerId, name, data })
    .select('id')
    .single();
  if (error) throw error;
  return (row as { id: string }).id;
}

export async function saveProject(
  id: string,
  patch: { name?: string; data?: ProjectState; thumbnail_url?: string | null },
  options?: { signal?: AbortSignal },
): Promise<void> {
  const sb = requireClient();
  // signal を渡すと（離脱時オートセーブのタイムアウトなど）リクエストを中断できる。
  // 中断すると stale なスナップショットが後から DB に書き込まれて新しい保存を上書きするのを防げる。
  const query = sb.from('projects').update(patch).eq('id', id);
  const { error } = await (options?.signal ? query.abortSignal(options.signal) : query);
  if (error) throw error;
}

export async function duplicateProject(id: string): Promise<string> {
  const src = await getProject(id);
  if (!src) throw new Error('複製元のプロジェクトが見つかりません。');
  return createProject(`${src.name} のコピー`, src.data);
}

/** 論理削除（deleted_at セット）＋ 猶予後に物理削除されるよう purge 予約。 */
export async function softDeleteProject(id: string): Promise<void> {
  const sb = requireClient();
  const now = new Date();
  const purgeAt = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  const { error } = await sb
    .from('projects')
    .update({ deleted_at: now.toISOString(), scheduled_purge_at: purgeAt.toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** 閲覧用URLのトークンを発行して返す。 */
export async function createShareLink(projectId: string): Promise<string> {
  const sb = requireClient();
  const { data: userData } = await sb.auth.getUser();
  const createdBy = userData.user?.id;
  if (!createdBy) throw new Error('未ログインのため共有リンクを発行できません。');
  const { data, error } = await sb
    .from('project_shares')
    .insert({ project_id: projectId, created_by: createdBy })
    .select('token')
    .single();
  if (error) throw error;
  return (data as { token: string }).token;
}

/** 閲覧用URLのトークンから共有プロジェクトを取得（SECURITY DEFINER RPC 経由）。 */
export async function getSharedProject(token: string): Promise<SharedProject | null> {
  const sb = requireClient();
  const { data, error } = await sb.rpc('get_shared_project', { p_token: token });
  if (error) throw error;
  const rows = (data as SharedProject[] | null) ?? [];
  return rows[0] ?? null;
}
