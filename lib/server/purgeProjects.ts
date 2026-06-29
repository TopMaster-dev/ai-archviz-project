import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// 猶予期間（14日）を過ぎた論理削除済みプロジェクトの「物理削除＋容量解放」（260629 クライアント要望）。
//
// 背景: 旧来は pg_cron（arise_purge_deleted → purge_soft_deleted_projects）が行を物理削除していたが、
// DB から Storage API は呼べないため AI生成画像（{owner}/ai-render/{projectId}/...）が消えず容量が解放されなかった。
// そこで row 削除の前に Storage 実体を service_role で削除する本ジョブ（Vercel Cron）へ置き換える。
// ⚠️ クライアントからは import しないこと（service_role を扱うサーバ専用モジュール）。
//
// 堅牢性: Storage 解放に失敗したプロジェクトの行は削除しない（次回再試行）。先に行を消すと owner/projectId が
// 失われ画像が永久に孤児化するため、「Storage 解放できた行だけ」を削除する。

const BUCKET = 'user-uploads';

export interface PurgeProjectsEnv {
  url: string;
  serviceKey: string;
}

export interface PurgeProjectsResult {
  success: boolean;
  reason?: string;
  purged?: number;        // 物理削除した行数
  storageDeleted?: number; // 削除した Storage オブジェクト数
  failed?: number;         // Storage 解放に失敗し行を残した（再試行予定の）プロジェクト数
}

/**
 * prefix 配下の Storage オブジェクトをページングしながら全削除する。
 * 完全に消し切れたら ok=true。エラー/打ち切りで未完了なら ok=false（呼び出し側は行を残して次回再試行）。
 */
async function deleteStorageFolder(
  admin: SupabaseClient,
  prefix: string,
): Promise<{ deleted: number; ok: boolean }> {
  let deleted = 0;
  // 削除のたびに残りが先頭へ来るため offset は常に 0。安全打ち切りとして最大ページ数を設ける。
  for (let page = 0; page < 50; page += 1) {
    const { data: files, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 1000 });
    if (error) {
      console.error('[purge-projects] list failed for', prefix, error.message);
      return { deleted, ok: false };
    }
    if (!files || files.length === 0) return { deleted, ok: true }; // 空＝完了（消すものが無い場合も成功）
    const paths = files.filter((f) => f.name).map((f) => `${prefix}/${f.name}`);
    if (paths.length === 0) return { deleted, ok: true };
    const { error: rmErr } = await admin.storage.from(BUCKET).remove(paths);
    if (rmErr) {
      console.error('[purge-projects] remove failed for', prefix, rmErr.message);
      return { deleted, ok: false };
    }
    deleted += paths.length;
    if (files.length < 1000) return { deleted, ok: true }; // 最終ページまで消し切った
  }
  console.warn('[purge-projects] folder not fully cleared (page cap) for', prefix);
  return { deleted, ok: false };
}

/**
 * 猶予を過ぎた論理削除済みプロジェクトを物理削除する。行を消す前に、その AI生成画像
 * （{owner}/ai-render/{projectId}/...）の Storage 実体も削除して容量を解放する。
 * 素材（model/texture）は user_uploads 側で project_id が null 化されるだけで消えない（再利用資産）。
 * service_role 専用（RLS バイパス）。Vercel Cron（api/cron/purge-projects）から日次で呼ぶ。
 */
export async function runPurgeProjects(env: PurgeProjectsEnv): Promise<PurgeProjectsResult> {
  if (!env.url || !env.serviceKey) return { success: false, reason: 'server-not-configured' };
  const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin
    .from('projects')
    .select('id, owner_id')
    .not('deleted_at', 'is', null)
    .not('scheduled_purge_at', 'is', null)
    .lt('scheduled_purge_at', new Date().toISOString());
  if (error) {
    console.error('[purge-projects] query failed:', error.message); // 詳細はログのみ
    return { success: false, reason: 'query-failed' };
  }
  const targets = (data ?? []) as { id: string; owner_id: string }[];
  if (targets.length === 0) return { success: true, purged: 0, storageDeleted: 0 };

  // 1) 先に Storage（ai-render）を解放（行削除後は owner/projectId が分からなくなるため必ず先に）。
  //    解放できたプロジェクトの行だけを削除対象にする（失敗分は行を残して次回再試行＝孤児化防止）。
  let storageDeleted = 0;
  const okIds: string[] = [];
  const failedIds: string[] = [];
  for (const t of targets) {
    let ok = false;
    try {
      const r = await deleteStorageFolder(admin, `${t.owner_id}/ai-render/${t.id}`);
      ok = r.ok;
      storageDeleted += r.deleted;
    } catch (e) {
      console.error('[purge-projects] storage cleanup threw for', t.id, (e as Error)?.message || e);
    }
    (ok ? okIds : failedIds).push(t.id);
  }
  if (failedIds.length > 0) {
    console.error('[purge-projects] storage incomplete; keeping rows for retry:', failedIds.join(','));
  }

  // 2) 行を物理削除（Storage 解放に成功した分のみ）。
  let purged = 0;
  if (okIds.length > 0) {
    const { error: delErr } = await admin.from('projects').delete().in('id', okIds);
    if (delErr) {
      console.error('[purge-projects] row delete failed:', delErr.message);
      return { success: false, reason: 'delete-failed', purged: 0, storageDeleted, failed: failedIds.length };
    }
    purged = okIds.length;
  }
  return {
    success: failedIds.length === 0,
    reason: failedIds.length > 0 ? 'partial' : undefined,
    purged,
    storageDeleted,
    failed: failedIds.length,
  };
}
