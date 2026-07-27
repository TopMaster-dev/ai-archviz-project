import { getSupabase } from './supabaseClient.js';
import { deleteAiRenderImagesForProject, ensureDataUrl, toStoredImage } from './aiRenderStorage.js';
import type { ProjectState } from '../project/projectState.js';
import type { ProjectRow, ProjectSummary, DeletedProjectSummary, SharedProject } from './types.js';
import { collectAiRenderUrls } from '../aiImageRefs.js';

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
    .select('id, name, thumbnail_url, updated_at, memo, kind:data->>kind')
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

export async function createProject(name: string, data: ProjectState, memo?: string): Promise<string> {
  const sb = requireClient();
  const { data: userData } = await sb.auth.getUser();
  const ownerId = userData.user?.id;
  if (!ownerId) throw new Error('未ログインのためプロジェクトを作成できません。');
  const trimmedMemo = memo?.trim();
  const { data: row, error } = await sb
    .from('projects')
    .insert({ owner_id: ownerId, name, data, memo: trimmedMemo ? trimmedMemo : null })
    .select('id')
    .single();
  if (error) throw error;
  return (row as { id: string }).id;
}

export async function saveProject(
  id: string,
  patch: { name?: string; data?: ProjectState; thumbnail_url?: string | null; memo?: string | null },
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
async function rehomeAiImagesCounted(
  data: ProjectState,
  newProjectId: string,
): Promise<{ rehomed: ProjectState | null; failed: number }> {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return { rehomed: null, failed: 0 };
  }
  const urls = collectAiRenderUrls(data);
  if (urls.length === 0) return { rehomed: null, failed: 0 };
  let result = json;
  let changed = false;
  let failed = 0;
  for (const url of urls) {
    try {
      const dataUrl = await ensureDataUrl(url); // 元画像をダウンロード
      if (!dataUrl.startsWith('data:')) {
        failed += 1; // 取得失敗＝他人の領域を指したまま残る
        continue;
      }
      const newUrl = await toStoredImage(dataUrl, newProjectId); // 新ID配下へ保存
      if (newUrl && newUrl !== url && newUrl.startsWith('http')) {
        result = result.split(url).join(newUrl); // 同一URLの全出現を新URLへ
        changed = true;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  if (!changed) return { rehomed: null, failed };
  try {
    return { rehomed: JSON.parse(result) as ProjectState, failed };
  } catch {
    return { rehomed: null, failed };
  }
}

/**
 * 同一ユーザー内の複製（260728 クライアント #1）。
 *
 * 要望:「同じデータであればリンクで読ませる」。以前は AI生成画像を1枚ずつ download→re-upload して
 * 物理コピーしていたため、複製のたびにファイル数と使用容量が倍増し、複製自体も重かった。
 * 同じ所有者の中では実体を共有し、URL をそのまま引き継ぐ。
 *
 * ※これが成立するのは、削除側が「オーナーのどのプロジェクトからも参照されていない実体だけ消す」
 *   参照カウントに対応済みだから（lib/db/aiRenderStorage.ts / lib/server/purgeProjects.ts /
 *   lib/server/orphanCleanup.ts）。**この関数だけを先にリリースしてはいけない**（元を削除した瞬間に
 *   コピー側の画像が全て 404 になる）。
 *
 * 別ユーザーへのコピーは copySharedProject（実体を複製）を使うこと。
 */
export async function duplicateProject(id: string): Promise<string> {
  const src = await getProject(id);
  if (!src) throw new Error('複製元のプロジェクトが見つかりません。');
  const newId = await createProject(`${src.name} のコピー`, src.data, src.memo ?? undefined);
  // サムネイルも引き継ぐ（DB列のdataURLなのでStorageとは無関係・複製直後の一覧が空にならない）。
  if (src.thumbnail_url) {
    try {
      await saveProject(newId, { thumbnail_url: src.thumbnail_url });
    } catch {
      /* サムネはベストエフォート（次回保存時に付く） */
    }
  }
  return newId;
}

/**
 * 別ユーザーのプロジェクトを自分のものとしてコピーする（共有ビューアの「複製して編集」・260728 #1）。
 *
 * 要望2:「別ユーザーへの複製→そのときだけファイルをコピーする」。
 * ここでリンク共有にしてしまうと、(a) 画像が元所有者の容量に計上され続ける、(b) コピー側は
 * Storage RLS（先頭フォルダ=自分のUID）により削除も管理もできない、(c) 元所有者が完全削除すると
 * 無言で壊れる、という三重の問題が起きる。よって実体を自分の配下へ複製する。
 *
 * 取り込めなかった画像がある場合は件数を返す（呼び出し側でユーザーに知らせる）。
 * 握りつぶすと「他人の領域への永久リンク」が黙って残るため、同一ユーザー複製のような緩さは採らない。
 */
export async function copySharedProject(
  name: string,
  data: ProjectState,
): Promise<{ id: string; failedImageCount: number }> {
  const newId = await createProject(name, data);
  let failedImageCount = 0;
  try {
    const { rehomed, failed } = await rehomeAiImagesCounted(data, newId);
    failedImageCount = failed;
    if (rehomed) await saveProject(newId, { data: rehomed });
  } catch (e) {
    console.warn('[copyShared] AI画像の取り込みに失敗', e);
    failedImageCount = -1; // 不明（全部失敗した可能性）
  }
  return { id: newId, failedImageCount };
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
