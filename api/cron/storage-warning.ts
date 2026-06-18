import { runStorageWarning } from '../../lib/server/storageWarning.js';
import { STORAGE_SOFT_LIMIT_BYTES, STORAGE_WARN_THRESHOLD_BYTES } from '../../lib/storageLimits.js';

// 容量警告メール（管理表 row 31）。Vercel Cron（vercel.json）から日次で呼ばれる。
// CRON_SECRET（Authorization: Bearer）で保護。Vercel Cron は CRON_SECRET 設定時に自動で同ヘッダを付ける。
// 外部スケジューラ（GitHub Actions の curl 等）からも同じヘッダで起動できる。
// しきい値/上限の既定は lib/storageLimits.ts（クライアントと共有）。env で個別に上書き可。

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  // 公開エンドポイントなので CRON_SECRET 必須（未設定/不一致は 401＝誰でも叩けない）。
  const secret = process.env.CRON_SECRET || '';
  const auth = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runStorageWarning(
      {
        url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
        serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        smtpHost: process.env.SMTP_HOST || '',
        smtpPort: Number(process.env.SMTP_PORT || 587),
        smtpSecure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        smtpUser: process.env.SMTP_USER || undefined,
        smtpPass: process.env.SMTP_PASS || undefined,
        smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || '',
        thresholdBytes: Number(process.env.STORAGE_WARN_BYTES || STORAGE_WARN_THRESHOLD_BYTES),
        limitBytes: Number(process.env.STORAGE_LIMIT_BYTES || STORAGE_SOFT_LIMIT_BYTES),
      },
      new Date().toISOString(),
    );
    return res.status(200).json(result);
  } catch (e: any) {
    console.error('storage-warning error:', e?.message || e); // 詳細はログのみ
    return res.status(200).json({ success: false, reason: 'error' });
  }
}
