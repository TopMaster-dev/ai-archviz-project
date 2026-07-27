import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * サーバ側（cron purge / 孤児掃除）の AI生成画像 参照集合（260728 クライアント #1）。
 *
 * 背景: プロジェクト複製を「実体コピー」から「リンク共有」に変えたため、
 * `{uid}/ai-render/{projectId}` フォルダは、その projectId のプロジェクトより長生きし得る
 * （別のプロジェクトが同じ実体を参照している状態が正常系になった）。
 * したがって削除処理は **フォルダ単位ではなくファイル単位** で、
 * 「オーナーのどのプロジェクトからも参照されていない実体だけ」を消さなければならない。
 *
 * 失敗時は null を返す。呼び出し側は null を「判定不能」として扱い、**1件も削除しない**こと
 * （RPC 未適用の本番へコードだけ出ても、容量リークで済み、生きている画像は壊れない）。
 */
export async function fetchOwnerAiRenderRefs(
  admin: SupabaseClient,
  ownerId: string,
  excludeProjectIds: string[] = [],
): Promise<Set<string> | null> {
  if (!ownerId) return null;
  try {
    const { data, error } = await admin.rpc('ai_render_refs_for_owner', {
      p_owner: ownerId,
      p_exclude: excludeProjectIds.filter(Boolean),
    });
    if (error) {
      console.error('[ai-render-refs] rpc failed for owner', ownerId, error.message);
      return null;
    }
    const rows = Array.isArray(data) ? (data as unknown[]) : [];
    return new Set(rows.filter((r): r is string => typeof r === 'string'));
  } catch (e) {
    console.error('[ai-render-refs] rpc threw for owner', ownerId, (e as Error)?.message || e);
    return null;
  }
}
