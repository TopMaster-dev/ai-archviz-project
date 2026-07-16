import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { getSupabase } from '../../lib/db/supabaseClient.js';
import { exitAdminDashboard } from '../../lib/admin/adminClient.js';

/**
 * 運営（管理者）向けダッシュボード（260711・フェーズ1）。URL に ?admin を付けて開く。
 * サーバー(/api/admin/orphan-cleanup?action=...)へログイン中ユーザーの access token を付けて問い合わせ、
 * ADMIN_EMAILS 許可リストの管理者のみデータを取得できる（非管理者にはアクセス権なし表示）。
 * 表示: AIキーの状態（設定有無・末尾マスクのみ・実値は出さない=プランA）＋ AI利用状況/概算費用。
 * ※ サーバー専用モジュール（lib/server/*）は import しない。API 経由のみ。
 */

interface KeyItem {
  id: string;
  label: string;
  envVar: string;
  configured: boolean;
  masked: string;
  billing: 'user-byok' | 'operator';
  note?: string;
}
interface GroupAgg {
  key: string;
  events: number;
  images: number;
  tokens: number;
  costUsd: number;
  costEstimated: boolean;
}
interface Summary {
  ok: boolean;
  reason?: string;
  totalEvents: number;
  totalCostUsd: number;
  byModel: GroupAgg[];
  byUser: GroupAgg[];
  byProject: GroupAgg[];
  note: string;
}
interface KeyTest {
  engine: string;
  configured: boolean;
  valid: boolean;
  detail: string;
}
interface InfraProvider {
  id: string;
  label: string;
  configured: boolean;
  link: string;
  metrics?: Array<{ label: string; value: string }>;
  note?: string;
  error?: string;
}
interface InfraStatus {
  cloudinary: InfraProvider;
  supabase: InfraProvider;
  vercel: InfraProvider;
}

/** キー id → テスト用エンジン名（テスト可能なもののみ）。 */
const KEY_ENGINE: Record<string, 'gemini' | 'replicate'> = {
  'gemini-service': 'gemini',
  'eraser-replicate': 'replicate',
};

const yen = (usd: number) => `約¥${Math.round(usd * 150).toLocaleString('ja-JP')}`; // 150円/$の概算表示
const usd = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`;

async function adminFetch(action: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
  const sb = getSupabase();
  const token = sb ? (await sb.auth.getSession()).data.session?.access_token : null;
  return fetch(`/api/admin/orphan-cleanup?action=${action}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

interface UserStatus {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
  plan: string | null;
  aiCreditsTotal: number;
  aiCreditsUsed: number;
  aiCreditsRemaining: number;
  graceExpiresAt: string | null;
  graceExpired: boolean;
  lockedAt: string | null;
  lockReason: string | null;
  registeredAt: string | null;
  createdAt: string | null;
}

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** 運営がユーザーのフリープラン猶予期限（AIクレジット期限）を延長/失効する（#4・260715）。 */
function GraceManagerCard() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [resetCredits, setResetCredits] = useState(false);
  const [customDate, setCustomDate] = useState('');

  const lookup = async () => {
    const q = email.trim();
    if (!q) return;
    setBusy(true);
    setMsg(null);
    setStatus(null);
    try {
      const r = await adminFetch(`user-status&email=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (r.ok && j?.status) {
        setStatus(j.status);
      } else {
        setMsg(j?.error === 'not-found' ? 'このメールのユーザーは見つかりませんでした。' : `取得に失敗しました（${j?.error ?? r.status}）。`);
      }
    } catch {
      setMsg('通信エラーが発生しました。');
    } finally {
      setBusy(false);
    }
  };

  const applyGrace = async (expiresAt: string | null) => {
    if (!status) return;
    setBusy(true);
    setMsg(null);
    try {
      const params = new URLSearchParams({ userId: status.id });
      if (expiresAt) params.set('expiresAt', expiresAt);
      if (resetCredits) params.set('resetCredits', '1');
      const r = await adminFetch(`set-grace&${params.toString()}`, 'POST');
      const j = await r.json();
      if (r.ok && j?.status) {
        setStatus(j.status);
        setMsg('更新しました。');
        setResetCredits(false);
        setCustomDate('');
      } else {
        setMsg(`更新に失敗しました（${j?.error ?? r.status}）。`);
      }
    } catch {
      setMsg('通信エラーが発生しました。');
    } finally {
      setBusy(false);
    }
  };

  // 延長の基準日時 = 現在の期限が未来ならそれ、過ぎている/未設定なら今。そこへ日数を足す。
  const extendByDays = (days: number) => {
    const base = status?.graceExpiresAt && !status.graceExpired ? new Date(status.graceExpiresAt).getTime() : Date.now();
    void applyGrace(new Date(base + days * 24 * 60 * 60 * 1000).toISOString());
  };
  const expireNow = () => void applyGrace(new Date().toISOString());
  const applyCustom = () => {
    if (!customDate) return;
    // 入力日の終わり（23:59:59）を期限にする。
    void applyGrace(new Date(`${customDate}T23:59:59`).toISOString());
  };

  return (
    <Card>
      <h3 className="mb-1 text-sm font-bold text-emerald-300">フリープラン猶予期間の管理</h3>
      <p className="mb-3 text-[11px] text-neutral-500">
        対象ユーザーの「フリープランの猶予期限（AIクレジットの有効期限）」を延長・失効します。期限を延ばすとその日まで利用でき、
        「今すぐ失効」で即時に期限切れ扱いになります（制限の発動はフリープラン制限が有効な場合）。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void lookup(); }}
          placeholder="ユーザーのメールアドレス"
          className="min-w-[220px] flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/60"
        />
        <button
          type="button"
          onClick={() => void lookup()}
          disabled={busy || !email.trim()}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
        >
          検索
        </button>
      </div>

      {status && (
        <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-white">{status.displayName || '(名称未設定)'}</div>
              <div className="truncate text-[11px] text-neutral-400">{status.email}</div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${status.plan === 'paid' ? 'bg-sky-500/15 text-sky-300' : 'bg-neutral-700/50 text-neutral-300'}`}>
                {status.plan === 'paid' ? '有料' : 'フリー'}
              </span>
              {status.lockedAt && <span className="rounded bg-red-500/15 px-2 py-0.5 text-[11px] font-bold text-red-300">ロック中</span>}
            </div>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div className="flex justify-between"><dt className="text-neutral-400">AIクレジット</dt><dd className="font-mono text-neutral-200">残 {status.aiCreditsRemaining} / {status.aiCreditsTotal}</dd></div>
            <div className="flex justify-between">
              <dt className="text-neutral-400">猶予期限</dt>
              <dd className={`font-mono ${status.graceExpired ? 'text-red-300' : 'text-emerald-300'}`}>{fmtDate(status.graceExpiresAt)}{status.graceExpired ? '（失効）' : ''}</dd>
            </div>
          </dl>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => extendByDays(30)} disabled={busy} className="rounded-md border border-white/10 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:border-emerald-400 disabled:opacity-40">＋30日延長</button>
            <button type="button" onClick={() => extendByDays(90)} disabled={busy} className="rounded-md border border-white/10 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:border-emerald-400 disabled:opacity-40">＋90日延長</button>
            <button type="button" onClick={expireNow} disabled={busy} className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-200 hover:border-red-400 disabled:opacity-40">今すぐ失効</button>
            <span className="mx-1 h-4 w-px bg-white/10" />
            <input
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              className="rounded-md border border-white/15 bg-black/40 px-2 py-1 text-[11px] text-white outline-none focus:border-emerald-500/60"
            />
            <button type="button" onClick={applyCustom} disabled={busy || !customDate} className="rounded-md border border-white/10 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:border-emerald-400 disabled:opacity-40">この日まで延長</button>
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-300">
            <input type="checkbox" checked={resetCredits} onChange={(e) => setResetCredits(e.target.checked)} className="accent-emerald-500" />
            延長時に AIクレジットも満タン（50）に戻す
          </label>
        </div>
      )}
      {msg && <p className="mt-2 text-[11px] text-neutral-400">{msg}</p>}
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-white/10 bg-neutral-900/70 p-4">{children}</div>;
}

function GroupTable({ title, rows, note }: { title: string; rows: GroupAgg[]; note?: string }) {
  return (
    <Card>
      <h3 className="mb-2 text-sm font-bold text-emerald-300">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead className="text-neutral-400">
            <tr className="text-left">
              <th className="py-1 pr-3 font-semibold">キー</th>
              <th className="py-1 pr-3 text-right font-semibold">回数</th>
              <th className="py-1 pr-3 text-right font-semibold">画像</th>
              <th className="py-1 pr-3 text-right font-semibold">トークン</th>
              <th className="py-1 text-right font-semibold">概算費用</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-neutral-500">
                  データがありません（計測開始後に集計されます）。
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-white/5">
                <td className="py-1 pr-3 font-mono text-[11px] break-all text-neutral-200">
                  {r.key.length > 40 ? `${r.key.slice(0, 8)}…${r.key.slice(-6)}` : r.key}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{r.events.toLocaleString('ja-JP')}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{r.images.toLocaleString('ja-JP')}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{r.tokens.toLocaleString('ja-JP')}</td>
                <td className="py-1 text-right tabular-nums">
                  {yen(r.costUsd)}
                  {r.costEstimated && <span className="ml-1 text-amber-400" title="単価不明の行を含む">*</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="mt-2 text-[11px] text-neutral-500">{note}</p>}
    </Card>
  );
}

export function AdminDashboard() {
  const [state, setState] = useState<'loading' | 'forbidden' | 'ready' | 'error'>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [infra, setInfra] = useState<InfraStatus | null>(null);
  const [tests, setTests] = useState<Record<string, KeyTest | 'testing'>>({});

  useEffect(() => {
    void (async () => {
      try {
        const who = await (await adminFetch('whoami')).json();
        if (!who?.isAdmin) {
          setState('forbidden');
          return;
        }
        setEmail(who.email ?? null);
        const [kh, us, inf] = await Promise.all([
          adminFetch('keyhealth').then((r) => r.json()),
          adminFetch('usage').then((r) => r.json()),
          adminFetch('infra').then((r) => r.json()),
        ]);
        setKeys(Array.isArray(kh?.keys) ? kh.keys : []);
        setSummary(us?.summary ?? null);
        setInfra(inf?.infra ?? null);
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  const runTest = async (engine: 'gemini' | 'replicate') => {
    setTests((t) => ({ ...t, [engine]: 'testing' }));
    try {
      const r = await (await adminFetch(`testkey&engine=${engine}`)).json();
      setTests((t) => ({ ...t, [engine]: r?.result ?? { engine, configured: false, valid: false, detail: 'error' } }));
    } catch {
      setTests((t) => ({ ...t, [engine]: { engine, configured: false, valid: false, detail: '通信エラー' } }));
    }
  };

  if (state === 'loading') {
    return <div className="h-screen overflow-y-auto bg-neutral-950 p-8 text-neutral-300">読み込み中…</div>;
  }
  if (state === 'forbidden') {
    return (
      <div className="h-screen overflow-y-auto bg-neutral-950 p-8 text-neutral-300">
        <h1 className="text-lg font-bold text-white">運営ダッシュボード</h1>
        <p className="mt-2 text-sm">
          アクセス権がありません（管理者のみ）。ログイン中のアカウントのメールを、環境変数 <code>ADMIN_EMAILS</code>
          に追加すると閲覧できます。
        </p>
        <button
          type="button"
          onClick={exitAdminDashboard}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-neutral-200 transition hover:bg-neutral-700"
        >
          <ArrowLeft className="h-4 w-4" /> ホームに戻る
        </button>
      </div>
    );
  }
  if (state === 'error') {
    return <div className="h-screen overflow-y-auto bg-neutral-950 p-8 text-red-300">読み込みに失敗しました。</div>;
  }

  return (
    // #root は overflow:hidden で高さ固定のため、ダッシュボードは自前の縦スクロール領域にする
    // （min-h-screen だと内容がはみ出してスクロールできない・260716 修正）。
    <div className="h-screen overflow-y-auto scroll-dark bg-neutral-950 p-6 text-white">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={exitAdminDashboard}
              title="ホーム（プロジェクト一覧）に戻る"
              className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 transition hover:bg-neutral-700"
            >
              <ArrowLeft className="h-4 w-4" /> ホームに戻る
            </button>
            <h1 className="text-xl font-black">運営ダッシュボード</h1>
          </div>
          <span className="text-xs text-neutral-400">{email}</span>
        </header>

        {/* AIキーの状態（プランA: 値は表示しない） */}
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-neutral-200">AIキーの状態</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {keys.map((k) => (
              <Card key={k.id}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">{k.label}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                      k.configured ? 'bg-emerald-500/15 text-emerald-300' : 'bg-neutral-700/50 text-neutral-400'
                    }`}
                  >
                    {k.configured ? '設定済み' : '未設定'}
                  </span>
                </div>
                <div className="mt-1 font-mono text-xs text-neutral-300">{k.masked}</div>
                <div className="mt-1 text-[11px] text-neutral-500">
                  <span className="font-mono">{k.envVar}</span> ・ 費用: {k.billing === 'operator' ? '運営負担' : 'ユーザー(BYOK)'}
                </div>
                {k.note && <div className="mt-1 text-[11px] text-neutral-500">{k.note}</div>}
                {KEY_ENGINE[k.id] && k.configured && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void runTest(KEY_ENGINE[k.id])}
                      disabled={tests[KEY_ENGINE[k.id]] === 'testing'}
                      className="rounded-md border border-white/10 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:border-emerald-400 disabled:opacity-50"
                    >
                      {tests[KEY_ENGINE[k.id]] === 'testing' ? 'テスト中…' : 'テスト'}
                    </button>
                    {tests[KEY_ENGINE[k.id]] && tests[KEY_ENGINE[k.id]] !== 'testing' && (
                      <span
                        className={`text-[11px] font-bold ${
                          (tests[KEY_ENGINE[k.id]] as KeyTest).valid ? 'text-emerald-300' : 'text-red-300'
                        }`}
                      >
                        {(tests[KEY_ENGINE[k.id]] as KeyTest).detail}
                      </span>
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
          <p className="text-[11px] text-neutral-500">
            キーの値はここに表示しません（設定・変更は Vercel の環境変数で行います＝プランA）。
          </p>
        </section>

        {/* AI利用状況/費用 */}
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-bold text-neutral-200">AI利用状況（直近）</h2>
            {summary?.ok && (
              <span className="text-xs text-neutral-400">
                合計 {summary.totalEvents.toLocaleString('ja-JP')} 回 ・ 概算 {yen(summary.totalCostUsd)}（{usd(summary.totalCostUsd)}）
              </span>
            )}
          </div>
          {!summary?.ok ? (
            <Card>
              <p className="text-xs text-neutral-400">
                集計を取得できませんでした{summary?.reason ? `（${summary.reason}）` : ''}。計測が有効化され、
                利用が発生すると表示されます。
              </p>
            </Card>
          ) : (
            <>
              <GroupTable title="モデル別" rows={summary.byModel} note={summary.note} />
              <div className="grid gap-3 lg:grid-cols-2">
                <GroupTable title="ユーザー別（上位）" rows={summary.byUser} />
                <GroupTable title="案件（プロジェクト）別（上位）" rows={summary.byProject} />
              </div>
              <p className="text-[11px] text-neutral-500">
                * 印は単価不明の行を含む概算。¥は 150円/$ での目安表示です。
              </p>
            </>
          )}
        </section>

        {/* 運営操作: ユーザーの猶予期間管理（#4） */}
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-neutral-200">運営操作</h2>
          <GraceManagerCard />
        </section>

        {/* インフラ状況（Cloudinary / Supabase / Vercel） */}
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-neutral-200">インフラ状況</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {infra &&
              [infra.cloudinary, infra.supabase, infra.vercel].map((p) => (
                <Card key={p.id}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">{p.label}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                        p.configured ? 'bg-emerald-500/15 text-emerald-300' : 'bg-neutral-700/50 text-neutral-400'
                      }`}
                    >
                      {p.configured ? '接続' : '未設定'}
                    </span>
                  </div>
                  {p.metrics && p.metrics.length > 0 && (
                    <dl className="mt-2 space-y-1">
                      {p.metrics.map((m) => (
                        <div key={m.label} className="flex justify-between text-xs">
                          <dt className="text-neutral-400">{m.label}</dt>
                          <dd className="font-mono text-neutral-200 break-all text-right">{m.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {p.error && <div className="mt-1 text-[11px] text-red-300">取得エラー: {p.error}</div>}
                  {p.note && <div className="mt-1 text-[11px] text-neutral-500">{p.note}</div>}
                  <a
                    href={p.link}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-[11px] text-emerald-400 hover:underline"
                  >
                    提供元ダッシュボードを開く →
                  </a>
                </Card>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}
