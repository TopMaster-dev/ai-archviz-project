import { createClient } from '@supabase/supabase-js';
import { runStorageWarning } from '../lib/server/storageWarning.js';
import { STORAGE_SOFT_LIMIT_BYTES, STORAGE_WARN_THRESHOLD_BYTES } from '../lib/storageLimits.js';

// 容量警告メールの「即時送信」エンドポイント（260629）。
// 日次 cron（api/cron/storage-warning）を待たず、アップロードで上限に近づいた直後に本人へ通知する。
// ログイン中ユーザーの JWT（Authorization: Bearer）で本人を特定し、その本人だけを対象に runStorageWarning を実行する。
// しきい値・クールダウン（再送防止）・使用量計測（storage.objects 集計）は cron と完全に共通。
// ⚠️ SMTP / SUPABASE_SERVICE_ROLE_KEY が未設定だと送信されない（cron と同条件）。

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !serviceKey) {
    return res.status(200).json({ success: false, reason: 'server-not-configured' });
  }

  // 本人特定: クライアントの access token を検証（service_role クライアントで getUser(token)）。
  const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    const ownerId = userData?.user?.id;
    if (userErr || !ownerId) return res.status(401).json({ error: 'Unauthorized' });

    const result = await runStorageWarning(
      {
        url,
        serviceKey,
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
      { ownerId },
    );
    return res.status(200).json(result);
  } catch (e: any) {
    console.error('storage-warning-self error:', e?.message || e); // 詳細はログのみ
    return res.status(200).json({ success: false, reason: 'error' });
  }
}
