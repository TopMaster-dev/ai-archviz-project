import { runPurgeProjects } from '../../lib/server/purgeProjects.js';

// 猶予(14日)超過の論理削除済みプロジェクトを物理削除＋容量解放（260629）。Vercel Cron（vercel.json）から日次。
// CRON_SECRET（Authorization: Bearer）で保護。pg_cron の arise_purge_deleted を置き換える
// （DB からは Storage を消せず AI生成画像が残るため。schema.sql で当該 pg_cron はスケジュールしない）。

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const secret = process.env.CRON_SECRET || '';
  const auth = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runPurgeProjects({
      url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    });
    // 失敗/部分失敗は 500 で返す（Vercel Cron の失敗アラート・外形監視に乗せるため）。本文は診断用に保持。
    return res.status(result.success ? 200 : 500).json(result);
  } catch (e: any) {
    console.error('purge-projects error:', e?.message || e); // 詳細はログのみ
    return res.status(500).json({ success: false, reason: 'error' });
  }
}
