import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

// 容量警告メール（管理表 row 31）の中核ロジック（サーバ専用）。
//
// アップロード総容量がしきい値（既定=上限の80%）に達したユーザーへ、上限到達前に整理を促すメールを
// SMTP で送信し、送信できた分だけ storage_warnings に最終通知時刻・通知時点の総容量を記録する
// （重複送信防止: クールダウン期間内かつ容量が増えていなければ次回は対象外）。
// api/cron/storage-warning（Vercel Cron）と vite dev middleware の双方から呼ぶ。
// ⚠️ クライアントからは import しないこと（service_role と SMTP 資格情報を扱うサーバ専用モジュール）。

export interface StorageWarningEnv {
  url: string;
  serviceKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom: string;
  /** 通知しきい値（バイト）。本人の総容量がこれ以上で通知対象。 */
  thresholdBytes: number;
  /** 文面に表示する上限（バイト）。クライアントの STORAGE_SOFT_LIMIT_BYTES と一致させる。 */
  limitBytes: number;
  /** 再通知までのクールダウン日数（既定7日）。 */
  cooldownDays?: number;
}

export interface StorageWarningResult {
  success: boolean;
  reason?: string;
  warned?: number;
  failed?: number;
  pending?: number;
}

interface TargetRow {
  owner_id: string;
  owner_email: string;
  total_bytes: number;
}

/** ログ用にメールアドレスを伏せる（PII をログ保管に残さない）。 */
function redactEmail(email: string): string {
  const [user, domain] = email.split('@');
  return domain ? `${user.slice(0, 1)}***@${domain}` : '***';
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

function buildMail(from: string, to: string, totalBytes: number, limitBytes: number) {
  const text = [
    'Arise をご利用いただきありがとうございます。',
    '',
    'アップロード済みデータの容量が上限に近づいています。',
    `現在の使用量: ${mb(totalBytes)}MB ／ 上限 ${mb(limitBytes)}MB`,
    '',
    '上限に達すると、新しいテクスチャ・3Dモデルのアップロードができなくなります。',
    '不要なアップロードは「マイ素材」またはホーム画面のアップロード管理から削除してください。',
    '',
    '※本メールは自動送信です。',
  ].join('\n');
  return { from, to, subject: '【Arise】アップロード容量が上限に近づいています', text };
}

/**
 * 通知対象を取得し、ユーザーごとに1通の SMTP メールを送り、送信成功分の storage_warnings を upsert する。
 * 失敗は次回再送できるよう記録しない。ベストエフォート（例外で落とさない）。
 */
export async function runStorageWarning(env: StorageWarningEnv, nowIso: string): Promise<StorageWarningResult> {
  if (!env.url || !env.serviceKey) return { success: false, reason: 'server-not-configured' };
  const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin.rpc('storage_warning_targets', {
    p_threshold_bytes: env.thresholdBytes,
    p_cooldown_days: env.cooldownDays ?? 7,
  });
  if (error) {
    console.error('[storage-warning] query failed:', error.message); // 詳細はログのみ
    return { success: false, reason: 'query-failed' };
  }
  const rows = (data ?? []) as TargetRow[];
  if (rows.length === 0) return { success: true, warned: 0, failed: 0 };

  // 通知対象はあるが SMTP 未設定: DB は変更せず保留（設定後の次回に送れる）。
  if (!env.smtpHost || !env.smtpFrom) return { success: false, reason: 'smtp-not-configured', pending: rows.length };

  const transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure, // 465=true / 587(STARTTLS)=false
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass ?? '' } : undefined,
  });

  const sent: { owner_id: string; warned_at: string; total_bytes: number }[] = [];
  let failed = 0;
  for (const r of rows) {
    try {
      await transporter.sendMail(buildMail(env.smtpFrom, r.owner_email, r.total_bytes, env.limitBytes));
      sent.push({ owner_id: r.owner_id, warned_at: nowIso, total_bytes: r.total_bytes });
    } catch (e) {
      failed++;
      console.error('[storage-warning] send failed for', redactEmail(r.owner_email), (e as Error)?.message || e);
    }
  }

  // 送信できた分だけ通知済みに（失敗分は記録せず次回再送）。
  if (sent.length > 0) {
    const { error: upErr } = await admin.from('storage_warnings').upsert(sent, { onConflict: 'owner_id' });
    if (upErr) console.error('[storage-warning] mark storage_warnings failed:', upErr.message);
  }
  return { success: true, warned: sent.length, failed };
}
