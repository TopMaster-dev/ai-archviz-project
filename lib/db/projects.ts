import { getSupabase } from './supabaseClient.js';
import { deleteAiRenderImagesForProject, ensureDataUrl, toStoredImage } from './aiRenderStorage.js';
import type { ProjectState } from '../project/projectState.js';
import type { ProjectRow, ProjectSummary, DeletedProjectSummary, SharedProject } from './types.js';

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
    // kind は data(jsonb) 内に保持しているため、軽量に種別だけ抽出する（260623 カテゴリ分け）。
    .select('id, name, thumbnail_url, updated_at, kind:data->>kind')
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

/**
 * 複製したプロジェクトの AI生成画像を、新しいプロジェクトID配下へ複製して URL を貼り替える（260630）。
 * 元プロジェクトと Storage を共有しないようにする（元を完全削除/purge してもコピーの画像が消えない）。
 * data 内の ai-render 公開URLを download→新IDで再upload→全置換。ベストエフォート（失敗したURLは元のまま=共有）。
 * 変更があれば新しい data を、無ければ null を返す。
 */
async function rehomeAiImages(data: ProjectState, newProjectId: string): Promise<ProjectState | null> {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return null;
  }
  const urls = Array.from(new Set(json.match(/https?:\/\/[^"\s\\]+\/ai-render\/[^"\s\\]+/g) ?? []));
  if (urls.length === 0) return null;
  let result = json;
  let changed = false;
  for (const url of urls) {
    try {
      const dataUrl = await ensureDataUrl(url); // 元画像をダウンロード
      if (!dataUrl.startsWith('data:')) continue; // 取得失敗→元のまま（共有）
      const newUrl = await toStoredImage(dataUrl, newProjectId); // 新ID配下へ保存
      if (newUrl && newUrl !== url && newUrl.startsWith('http')) {
        result = result.split(url).join(newUrl); // 同一URLの全出現を新URLへ
        changed = true;
      }
    } catch {
      /* このURLはスキップ（元のまま） */
    }
  }
  if (!changed) return null;
  try {
    return JSON.parse(result) as ProjectState;
  } catch {
    return null;
  }
}

export async function duplicateProject(id: string): Promise<string> {
  const src = await getProject(id);
  if (!src) throw new Error('複製元のプロジェクトが見つかりません。');
  const newId = await createProject(`${src.name} のコピー`, src.data);
  // コピーのAI生成画像を新ID配下へ複製し、元と Storage を共有しないようにする（260630・ベストエフォート）。
  try {
    const rehomed = await rehomeAiImages(src.data, newId);
    if (rehomed) await saveProject(newId, { data: rehomed });
  } catch (e) {
    console.warn('[duplicate] AI画像の複製に失敗（元と共有のまま）', e);
  }
  return newId;
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

/**
 * 猶予期間内に論理削除されたプロジェクト一覧（完全削除予定が近い順）。復元メニュー用（管理表 row 109/110）。
 * RLS の SELECT は所有者のみ（deleted_at 条件なし）のため、本人の削除済み行を取得できる（schema.sql 参照）。
 * scheduled_purge_at が未来（猶予内）のものだけを対象にする。
 */
export async function getDeletedProjects(): Promise<DeletedProjectSummary[]> {
  const sb = requireClient();
  const { data, error } = await sb
    .from('projects')
    .select('id, name, thumbnail_url, updated_at, scheduled_purge_at')
    .not('deleted_at', 'is', null)
    .gte('scheduled_purge_at', new Date().toISOString())
    .order('scheduled_purge_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DeletedProjectSummary[];
}

/** 論理削除済みプロジェクトを復元（deleted_at / scheduled_purge_at をクリアして一覧へ戻す）。 */
export async function restoreProject(id: string): Promise<void> {
  const sb = requireClient();
  const { error } = await sb
    .from('projects')
    .update({ deleted_at: null, scheduled_purge_at: null })
    .eq('id', id);
  if (error) throw error;
}

/**
 * プロジェクトを「完全に削除」する（猶予を待たず即時・260629 クライアント要望）。
 * 先にこのプロジェクトの AI生成画像（Storage 実体）を削除して容量を解放し、その後に行を物理削除する。
 * 素材（model/texture）は user_uploads 側で project_id が null 化されるだけで消えない（再利用資産のため）。
 */
export async function purgeProject(id: string): Promise<void> {
  const sb = requireClient();
  await deleteAiRenderImagesForProject(id); // 容量解放（ベストエフォート・行削除前に）
  const { error } = await sb.from('projects').delete().eq('id', id);
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
