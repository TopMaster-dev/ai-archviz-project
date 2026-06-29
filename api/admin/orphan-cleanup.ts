import { runOrphanCleanup } from '../../lib/server/orphanCleanup.js';

// 孤児 AI生成画像の一回限りの掃除（260629）。運用者が手動で1回叩く想定（cron 登録はしない）。
// CRON_SECRET（Authorization: Bearer）で保護＝運用者のみ実行可。
// 既定は dry-run（対象を数えるだけ・削除しない）。実削除は ?execute=1 を付けたときのみ。
//   確認:   curl -H "Authorization: Bearer <CRON_SECRET>" -X POST https://<app>/api/admin/orphan-cleanup
//   実削除: curl -H "Authorization: Bearer <CRON_SECRET>" -X POST "https://<app>/api/admin/orphan-cleanup?execute=1"

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const secret = process.env.CRON_SECRET || '';
  const auth = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const execute = /(?:[?&])execute=1(?:&|$)/.test(req.url || ''); // 明示時のみ実削除。既定は dry-run。
  try {
    const result = await runOrphanCleanup(
      {
        url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
        serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      },
      { dryRun: !execute },
    );
    return res.status(result.success ? 200 : 500).json(result);
  } catch (e: any) {
    console.error('orphan-cleanup error:', e?.message || e); // 詳細はログのみ
    return res.status(500).json({ success: false, reason: 'error' });
  }
}
