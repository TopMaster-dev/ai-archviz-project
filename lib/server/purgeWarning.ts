import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

// 事前削除通知メール（管理表 row 106）の中核ロジック（サーバ専用）。
//
// 自動失効（ライフサイクル）で論理削除され、まだ通知していないプロジェクトの所有者へ、
// 猶予期間後に完全削除される旨を SMTP で通知し、送信できた分だけ purge_warned_at を記録する。
// api/cron/purge-warning（Vercel Cron）と vite dev middleware の双方から呼ぶ。
// ⚠️ クライアントからは import しないこと（service_role と SMTP 資格情報を扱うサーバ専用モジュール）。

export interface PurgeWarningEnv {
  url: string;
  serviceKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom: string;
}

export interface PurgeWarningResult {
  success: boolean;
  reason?: string;
  warned?: number;
  recipients?: number;
  failed?: number;
  pending?: number;
}

interface TargetRow {
  project_id: string;
  project_name: string;
  owner_id: string;
  owner_email: string;
  scheduled_purge_at: string;
}

/** ログ用にメールアドレスを伏せる（PII をログ保管に残さない）。 */
function redactEmail(email: string): string {
  const [user, domain] = email.split('@');
  return domain ? `${user.slice(0, 1)}***@${domain}` : '***';
}

function buildMail(from: string, to: string, projectNames: string[], earliestPurgeIso: string) {
  const d = new Date(earliestPurgeIso);
  const dateStr = Number.isNaN(d.getTime())
    ? '近日'
    : d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
  const list = projectNames.map((n) => `・${n}`).join('\n');
  const text = [
    'Arise をご利用いただきありがとうございます。',
    '',
    '以下のプロジェクトデータは保存期間を経過したため、自動削除の対象になりました。',
    `${dateStr} 以降に完全に削除され、復元できなくなります。`,
    '',
    list,
    '',
    '引き続きご利用になる場合は、削除日までにホーム画面の「削除済み」から復元してください。',
    '',
    '※本メールは自動送信です。',
  ].join('\n');
  return { from, to, subject: '【Arise】データ自動削除のお知らせ（復元期限のご案内）', text };
}

/**
 * 通知対象を取得し、所有者ごとに1通の SMTP メールを送り、送信成功分の purge_warned_at を記録する。
 * 失敗は次回再送できるよう purge_warned_at を更新しない。ベストエフォート（例外で落とさない）。
 */
export async function runPurgeWarning(env: PurgeWarningEnv, nowIso: string): Promise<PurgeWarningResult> {
  if (!env.url || !env.serviceKey) return { success: false, reason: 'server-not-configured' };
  const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin.rpc('purge_warning_targets');
  if (error) {
    console.error('[purge-warning] query failed:', error.message); // 詳細はログのみ（レスポンスに生の内部文字列を出さない）
    return { success: false, reason: 'query-failed' };
  }
  const rows = (data ?? []) as TargetRow[];
  if (rows.length === 0) return { success: true, warned: 0, recipients: 0, failed: 0 };

  // 通知対象はあるが SMTP 未設定: DB は変更せず保留（設定後の次回に送れる）。
  if (!env.smtpHost || !env.smtpFrom) return { success: false, reason: 'smtp-not-configured', pending: rows.length };

  const transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure, // 465=true / 587(STARTTLS)=false
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass ?? '' } : undefined,
  });

  // 所有者（メール）ごとにまとめて1通。最も早い削除日を案内する。
  const byEmail = new Map<string, { ids: string[]; names: string[]; earliest: string }>();
  for (const r of rows) {
    const g = byEmail.get(r.owner_email) ?? { ids: [], names: [], earliest: r.scheduled_purge_at };
    g.ids.push(r.project_id);
    g.names.push(r.project_name || '無題のプロジェクト');
    if (r.scheduled_purge_at < g.earliest) g.earliest = r.scheduled_purge_at;
    byEmail.set(r.owner_email, g);
  }

  const sentIds: string[] = [];
  let failed = 0;
  for (const [email, g] of byEmail) {
    try {
      await transporter.sendMail(buildMail(env.smtpFrom, email, g.names, g.earliest));
      sentIds.push(...g.ids);
    } catch (e) {
      failed++;
      console.error('[purge-warning] send failed for', redactEmail(email), (e as Error)?.message || e);
    }
  }

  // 送信できた分だけ通知済みに（失敗分は purge_warned_at を更新せず次回再送）。
  if (sentIds.length > 0) {
    const { error: upErr } = await admin.from('projects').update({ purge_warned_at: nowIso }).in('id', sentIds);
    if (upErr) console.error('[purge-warning] mark purge_warned_at failed:', upErr.message);
  }
  return { success: true, warned: sentIds.length, recipients: byEmail.size, failed };
}
