/**
 * 管理ダッシュボードのインフラ状況取得（260712・フェーズ2・**サーバー専用**）。
 * Cloudinary / Supabase / Vercel の各ステータスを取得する。取得できない項目は正直に「未対応/リンク代替」を返す:
 *  - Cloudinary: Admin API の usage（容量・帯域・変換・クレジット）。最もクリーン。
 *  - Supabase: サービス側キーが設定済みかの状態＋提供元ダッシュボードへのリンク（DB/容量の詳細・帯域は今後RPC/リンク）。
 *  - Vercel: トークンがあれば最新デプロイの状態。利用量（帯域・関数実行）は公開APIが無くプランに依存するためリンク代替。
 *
 * 各プロバイダは資格情報が未設定でも安全に configured:false＋リンクを返す（キーレスでもビルド・表示可）。
 */

export interface InfraProvider {
  id: string;
  label: string;
  configured: boolean;
  link: string;
  /** 表示用の主要メトリクス（provider ごとに任意）。 */
  metrics?: Array<{ label: string; value: string }>;
  note?: string;
  error?: string;
}

export interface InfraStatus {
  cloudinary: InfraProvider;
  supabase: InfraProvider;
  vercel: InfraProvider;
}

function fmtBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

async function getCloudinary(): Promise<InfraProvider> {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME || '';
  const key = process.env.CLOUDINARY_API_KEY || '';
  const secret = process.env.CLOUDINARY_API_SECRET || '';
  const base: InfraProvider = {
    id: 'cloudinary',
    label: 'Cloudinary（画像ストレージ/CDN）',
    configured: !!(cloud && key && secret),
    link: cloud ? `https://console.cloudinary.com/console/${cloud}/usage` : 'https://console.cloudinary.com/',
  };
  if (!base.configured) return { ...base, note: 'CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET 未設定。' };
  try {
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/usage`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
    const d = (await res.json()) as {
      storage?: { usage?: number };
      bandwidth?: { usage?: number };
      transformations?: { usage?: number };
      credits?: { usage?: number; limit?: number };
    };
    return {
      ...base,
      metrics: [
        { label: 'ストレージ', value: fmtBytes(d.storage?.usage ?? 0) },
        { label: '帯域（当月）', value: fmtBytes(d.bandwidth?.usage ?? 0) },
        { label: '変換回数', value: (d.transformations?.usage ?? 0).toLocaleString('ja-JP') },
        {
          label: 'クレジット',
          value: `${(d.credits?.usage ?? 0).toFixed(2)} / ${d.credits?.limit ?? '-'}`,
        },
      ],
      note: '日次・前日基準の粒度（厳密な請求照合用ではありません）。',
    };
  } catch {
    return { ...base, error: '通信エラー' };
  }
}

async function getSupabase(): Promise<InfraProvider> {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const ref = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] || '';
  return {
    id: 'supabase',
    label: 'Supabase（DB / ストレージ）',
    configured: !!(url && serviceKey),
    link: ref ? `https://supabase.com/dashboard/project/${ref}/reports` : 'https://supabase.com/dashboard',
    note:
      !url || !serviceKey
        ? 'SUPABASE_URL / SERVICE_ROLE_KEY 未設定。'
        : 'DBサイズ・容量の数値と帯域は提供元ダッシュボードで確認（帯域は公開APIがないためリンク代替）。',
  };
}

async function getVercel(): Promise<InfraProvider> {
  const token = process.env.VERCEL_TOKEN || '';
  const projectId = process.env.VERCEL_PROJECT_ID || '';
  const base: InfraProvider = {
    id: 'vercel',
    label: 'Vercel（ホスティング / サーバーレス）',
    configured: !!(token && projectId),
    link: 'https://vercel.com/dashboard',
    note: '利用量（帯域・関数実行回数）は公開APIが無く、取得には上位プラン(Observability)が必要なためリンク代替。',
  };
  if (!base.configured) {
    return { ...base, note: 'VERCEL_TOKEN / VERCEL_PROJECT_ID 未設定（デプロイ状態の取得に必要）。利用量はリンク代替。' };
  }
  try {
    const res = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
    const d = (await res.json()) as { deployments?: Array<{ state?: string; readyState?: string; url?: string }> };
    const dep = d.deployments?.[0];
    const state = dep?.readyState || dep?.state || '不明';
    return {
      ...base,
      metrics: [
        { label: '最新デプロイ', value: String(state) },
        { label: 'URL', value: dep?.url ? `https://${dep.url}` : '-' },
      ],
    };
  } catch {
    return { ...base, error: '通信エラー' };
  }
}

export async function getInfraStatus(): Promise<InfraStatus> {
  const [cloudinary, supabase, vercel] = await Promise.all([getCloudinary(), getSupabase(), getVercel()]);
  return { cloudinary, supabase, vercel };
}
