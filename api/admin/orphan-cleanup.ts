import { runOrphanCleanup } from '../../lib/server/orphanCleanup.js';
import { verifyAdmin, getKeyHealth, getUsageSummary } from '../../lib/server/adminDashboard.js';

// 運用者向け管理エンドポイント。Vercel Hobby の関数数上限(12/12)のため、ここに以下を相乗りさせる（260711）:
//  - 既定（action なし）: 孤児 AI生成画像の掃除。CRON_SECRET（Authorization: Bearer）で保護。?execute=1 で実削除。
//  - 管理ダッシュボード読取（action=whoami/keyhealth/usage）: ログイン中ユーザーの access token を検証し
//    ADMIN_EMAILS 許可リストの管理者のみ許可。キーの実値は返さない（プランA）。
//   確認:   curl -H "Authorization: Bearer <CRON_SECRET>" -X POST https://<app>/api/admin/orphan-cleanup
//   実削除: curl -H "Authorization: Bearer <CRON_SECRET>" -X POST "https://<app>/api/admin/orphan-cleanup?execute=1"

function getAction(req: any): string {
  try {
    return new URL(req.url || '', 'http://x').searchParams.get('action') || '';
  } catch {
    return '';
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // --- 管理ダッシュボード読取（メール許可リスト認証）---
  const action = getAction(req);
  if (action === 'whoami' || action === 'keyhealth' || action === 'usage') {
    const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const admin = await verifyAdmin(token);
    if (action === 'whoami') {
      // 判定だけ返す（未認証・非管理者でも 200 で isAdmin:false＝UIの出し分け用。機微情報は返さない）。
      return res.status(200).json({ isAdmin: admin.ok, email: admin.ok ? admin.email : null });
    }
    if (!admin.ok) return res.status(admin.status).json({ error: admin.error });
    if (action === 'keyhealth') return res.status(200).json({ success: true, keys: getKeyHealth() });
    return res.status(200).json({ success: true, summary: await getUsageSummary() }); // action === 'usage'
  }

  // --- 既定: 孤児掃除（CRON_SECRET 認証・従来どおり）---
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
