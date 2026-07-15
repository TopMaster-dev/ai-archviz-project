import { runOrphanCleanup } from '../../lib/server/orphanCleanup.js';
import {
  verifyAdmin,
  getKeyHealth,
  getUsageSummary,
  testKey,
  findUserStatusByEmail,
  setUserGrace,
} from '../../lib/server/adminDashboard.js';
import { getInfraStatus } from '../../lib/server/adminInfra.js';

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

function getEngineParam(req: any): string {
  try {
    return new URL(req.url || '', 'http://x').searchParams.get('engine') || '';
  } catch {
    return '';
  }
}

function getQueryParam(req: any, name: string): string {
  try {
    return new URL(req.url || '', 'http://x').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // --- 管理ダッシュボード（メール許可リスト認証）---
  // READ: 状態の取得（GET）。WRITE: 猶予期間の設定（#4・必ず POST）。いずれも verifyAdmin 必須。
  const action = getAction(req);
  const DASHBOARD_ACTIONS = ['whoami', 'keyhealth', 'usage', 'testkey', 'infra', 'user-status'];
  const WRITE_ACTIONS = ['set-grace'];
  if (DASHBOARD_ACTIONS.includes(action) || WRITE_ACTIONS.includes(action)) {
    const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const admin = await verifyAdmin(token);
    if (action === 'whoami') {
      // 判定だけ返す（未認証・非管理者でも 200 で isAdmin:false＝UIの出し分け用。機微情報は返さない）。
      return res.status(200).json({ isAdmin: admin.ok, email: admin.ok ? admin.email : null });
    }
    if (!admin.ok) return res.status(admin.status).json({ error: admin.error });
    if (action === 'keyhealth') return res.status(200).json({ success: true, keys: getKeyHealth() });
    if (action === 'usage') return res.status(200).json({ success: true, summary: await getUsageSummary() });
    if (action === 'infra') return res.status(200).json({ success: true, infra: await getInfraStatus() });
    if (action === 'testkey') {
      const engine = getEngineParam(req);
      if (engine !== 'gemini' && engine !== 'replicate') {
        return res.status(400).json({ error: "engine は 'gemini' か 'replicate'。" });
      }
      return res.status(200).json({ success: true, result: await testKey(engine) });
    }
    // #4: メールでユーザーの状態（プラン・クレジット・猶予期限・ロック）を引く（管理者のみ・PII を含む）。
    if (action === 'user-status') {
      const result = await findUserStatusByEmail(getQueryParam(req, 'email'));
      if (!result.ok) return res.status(result.reason === 'not-found' ? 404 : 400).json({ error: result.reason });
      return res.status(200).json({ success: true, status: result.status });
    }
    // #4（WRITE）: 猶予期限（ai_credits_expires_at）を設定/失効。必ず POST。
    if (action === 'set-grace') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'set-grace は POST。' });
      const userId = getQueryParam(req, 'userId');
      if (!userId) return res.status(400).json({ error: 'userId が必要です。' });
      const expiresAt = getQueryParam(req, 'expiresAt'); // 空=null（失効させない）／過去日時=今すぐ失効
      const resetCredits = getQueryParam(req, 'resetCredits') === '1';
      const result = await setUserGrace({ userId, expiresAt: expiresAt || null, resetCredits });
      if (!result.ok) return res.status(result.reason === 'not-found' ? 404 : 400).json({ error: result.reason });
      return res.status(200).json({ success: true, status: result.status });
    }
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
