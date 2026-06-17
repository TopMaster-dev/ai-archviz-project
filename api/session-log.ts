import { createClient } from '@supabase/supabase-js';

// 端末・IP のログイン記録（管理表 row 53・不正利用防止の監査証跡）。
//
// クライアントから Supabase アクセストークン（Authorization: Bearer）と端末情報（UA/画面/TZ/言語）を
// 受け取り、サーバが見たリクエスト IP（x-forwarded-for）と合わせて login_events へ
// service_role で INSERT する。IP はサーバ側で付与するためクライアントから偽装できない。
//
// ベストエフォート: 記録失敗・未設定でもログイン自体は妨げない（常に 200 を返す）。
// 自動ロック（row 54）は本フェーズでは未実装（記録のみ）。

function clientIp(req: any): string | null {
  const pick = (h: unknown): string | null => {
    const raw = Array.isArray(h) ? h[0] : h;
    return typeof raw === 'string' && raw.trim() ? raw.split(',')[0].trim() : null;
  };
  // Vercel が付与する信頼できるクライアントIPを優先（x-forwarded-for は呼び出し側が詐称しうる）。
  return (
    pick(req.headers['x-real-ip']) ??
    pick(req.headers['x-vercel-forwarded-for']) ??
    pick(req.headers['x-forwarded-for']) ??
    req.socket?.remoteAddress ??
    null
  );
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.slice(0, max) : null;

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    // 未設定環境では黙ってスキップ（記録なし・ログインは継続）。reason で原因を可視化（秘匿値は出さない）。
    if (!url || !serviceKey) {
      return res.status(200).json({ success: false, skipped: true, reason: 'server-not-configured' });
    }

    const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      return res.status(200).json({ success: false, skipped: true, reason: 'no-token' });
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    // トークンを検証してユーザーを特定（クライアントが user_id を僭称できないようにする）。
    const { data: u, error: uErr } = await admin.auth.getUser(token);
    const userId = u?.user?.id;
    if (uErr || !userId) {
      return res.status(200).json({ success: false, skipped: true, reason: 'invalid-token' });
    }

    const b = (req.body ?? {}) as { userAgent?: string; screen?: string; timezone?: string; language?: string };
    // supabase-js は INSERT 失敗時に throw せず { error } を返すため、必ず error を検査する。
    // ここを無視すると、キーが anon（RLS で拒否）等のとき行が入らないのに success を返してしまう。
    const { error: insErr } = await admin.from('login_events').insert({
      user_id: userId,
      ip: clientIp(req),
      user_agent: str(b.userAgent, 500),
      screen: str(b.screen, 32),
      timezone: str(b.timezone, 64),
      language: str(b.language, 32),
    });
    if (insErr) {
      console.error('session-log insert failed:', insErr.message);
      return res.status(200).json({ success: false, reason: 'insert-failed', error: insErr.message });
    }

    return res.status(200).json({ success: true });
  } catch (e: any) {
    // 監査記録の失敗でログインを妨げない。
    console.error('session-log error:', e?.message || e);
    return res.status(200).json({ success: false, error: e?.message });
  }
}
