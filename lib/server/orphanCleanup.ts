import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// 孤児になった AI生成画像（{uid}/ai-render/{projectId}/...）の一回限りの掃除（260629 クライアント要望）。
//
// 背景: 容量解放修正(260629)より前に物理削除されたプロジェクトの AI生成画像は、行が消えているため
// プロジェクト単位の purge では拾えず Storage に残り続ける。本ジョブは「もう存在しないプロジェクトの
// ai-render フォルダ」と「unsaved フォルダ（旧仕様の置き場・現在は生成されない）」を削除して容量を解放する。
//
// ⚠️ 破壊的操作。安全のため:
//   - 既定は dryRun（数えるだけ・削除しない）。実削除は dryRun を明示的に false にしたときのみ。
//   - 削除対象は「全 projects 行の id 集合に含まれない ai-render/{id}」と「ai-render/unsaved」のみ。
//     id 集合の取得に1回でも失敗したら中断（不完全な集合で誤削除しないため）。
//   - Storage の列挙に失敗した場合も中断/スキップして success=false（不完全な走査を成功と誤報しない）。
//   - 触れるのは ai-render フォルダだけ（model/texture などの素材には一切触れない）。
//   - service_role 専用（RLS バイパス）。クライアントから import しないこと。

const BUCKET = 'user-uploads';
const PAGE = 1000;

export interface OrphanCleanupEnv {
  url: string;
  serviceKey: string;
}

export interface OrphanCleanupResult {
  success: boolean;
  reason?: string;
  dryRun: boolean;
  scannedUsers: number;
  existingProjects: number;
  orphanFolders: number;   // 削除対象フォルダ数（存在しないプロジェクト or unsaved）
  orphanFiles: number;     // 対象に含まれるファイル数
  deletedFiles: number;    // 実際に削除した数（dryRun 時は 0）
  failedDeletions: number; // remove に失敗したファイル数
  bytes: number;           // 対象の合計バイト（取得できた分）
  sampleFolders: string[]; // 確認用に対象フォルダのサンプル（最大50）
}

/** 全 projects 行の id を取得（論理削除含む＝行が存在するものは「生存」扱い）。失敗時は null（＝中断）。 */
async function fetchAllProjectIds(admin: SupabaseClient): Promise<Set<string> | null> {
  const ids = new Set<string>();
  for (let from = 0; from < 5_000_000; from += PAGE) {
    const { data, error } = await admin.from('projects').select('id').range(from, from + PAGE - 1);
    if (error) {
      console.error('[orphan-cleanup] projects query failed:', error.message);
      return null; // 不完全な集合では削除しない（安全側）
    }
    const rows = (data ?? []) as { id: string }[];
    for (const r of rows) ids.add(r.id);
    if (rows.length < PAGE) break;
  }
  return ids;
}

/** prefix 直下の「フォルダ名」を列挙（folder entry は id===null）。列挙エラー時は null。 */
async function listFolders(admin: SupabaseClient, prefix: string): Promise<string[] | null> {
  const names: string[] = [];
  for (let offset = 0; offset < 5_000_000; offset += PAGE) {
    const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: PAGE, offset });
    if (error) {
      console.error('[orphan-cleanup] list folders failed for', prefix, error.message);
      return null;
    }
    if (!data) break;
    for (const e of data) {
      if (e.id === null && e.name) names.push(e.name); // folder（ファイルは id 非null）
    }
    if (data.length < PAGE) break;
  }
  return names;
}

/** prefix 直下の「ファイル」を列挙（id 非null）。列挙エラー時は null。 */
async function listFiles(admin: SupabaseClient, prefix: string): Promise<{ name: string; size: number }[] | null> {
  const files: { name: string; size: number }[] = [];
  for (let offset = 0; offset < 5_000_000; offset += PAGE) {
    const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: PAGE, offset });
    if (error) {
      console.error('[orphan-cleanup] list files failed for', prefix, error.message);
      return null;
    }
    if (!data) break;
    for (const e of data) {
      if (e.id !== null && e.name) {
        const size = Number((e.metadata as { size?: unknown } | null)?.size ?? 0);
        files.push({ name: e.name, size: Number.isFinite(size) ? size : 0 });
      }
    }
    if (data.length < PAGE) break;
  }
  return files;
}

/**
 * 孤児 ai-render を掃除する。dryRun（既定 true）なら削除せず対象を数えるだけ。
 * 実削除は opts.dryRun === false を明示したときのみ。
 */
export async function runOrphanCleanup(
  env: OrphanCleanupEnv,
  opts: { dryRun: boolean },
): Promise<OrphanCleanupResult> {
  const dryRun = opts?.dryRun !== false; // 既定は安全側（明示 false のときだけ削除）
  const base: OrphanCleanupResult = {
    success: false, dryRun, scannedUsers: 0, existingProjects: 0,
    orphanFolders: 0, orphanFiles: 0, deletedFiles: 0, failedDeletions: 0, bytes: 0, sampleFolders: [],
  };
  if (!env.url || !env.serviceKey) return { ...base, reason: 'server-not-configured' };
  const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const existingIds = await fetchAllProjectIds(admin);
  if (!existingIds) return { ...base, reason: 'projects-query-failed' }; // 中断（誤削除防止）

  const uids = await listFolders(admin, '');
  if (uids === null) return { ...base, existingProjects: existingIds.size, reason: 'scan-incomplete' };

  let orphanFolders = 0;
  let orphanFiles = 0;
  let deletedFiles = 0;
  let failedDeletions = 0;
  let bytes = 0;
  let incomplete = false;
  const sampleFolders: string[] = [];

  for (const uid of uids) {
    const projFolders = await listFolders(admin, `${uid}/ai-render`);
    if (projFolders === null) { incomplete = true; continue; } // この user はスキップ＝次回再試行
    for (const pid of projFolders) {
      const isOrphan = pid === 'unsaved' || !existingIds.has(pid); // 存在しないプロジェクト or 旧unsaved
      if (!isOrphan) continue;
      const prefix = `${uid}/ai-render/${pid}`;
      const files = await listFiles(admin, prefix);
      if (files === null) { incomplete = true; continue; } // 列挙不能なら削除しない（部分削除を避ける）
      if (files.length === 0) continue;
      orphanFolders += 1;
      orphanFiles += files.length;
      bytes += files.reduce((s, f) => s + f.size, 0);
      if (sampleFolders.length < 50) sampleFolders.push(prefix);
      if (!dryRun) {
        const paths = files.map((f) => `${prefix}/${f.name}`);
        for (let i = 0; i < paths.length; i += PAGE) {
          const chunk = paths.slice(i, i + PAGE);
          const { error } = await admin.storage.from(BUCKET).remove(chunk);
          if (error) {
            console.error('[orphan-cleanup] remove failed for', prefix, error.message);
            failedDeletions += chunk.length;
          } else {
            deletedFiles += chunk.length;
          }
        }
      }
    }
  }

  const reason = incomplete ? 'scan-incomplete' : failedDeletions > 0 ? 'partial-delete' : undefined;
  return {
    success: !incomplete && failedDeletions === 0,
    reason,
    dryRun,
    scannedUsers: uids.length,
    existingProjects: existingIds.size,
    orphanFolders, orphanFiles, deletedFiles, failedDeletions, bytes, sampleFolders,
  };
}
