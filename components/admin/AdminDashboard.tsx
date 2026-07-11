import React, { useEffect, useState } from 'react';
import { getSupabase } from '../../lib/db/supabaseClient.js';

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

const yen = (usd: number) => `約¥${Math.round(usd * 150).toLocaleString('ja-JP')}`; // 150円/$の概算表示
const usd = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`;

async function adminFetch(action: string): Promise<Response> {
  const sb = getSupabase();
  const token = sb ? (await sb.auth.getSession()).data.session?.access_token : null;
  return fetch(`/api/admin/orphan-cleanup?action=${action}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
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

  useEffect(() => {
    void (async () => {
      try {
        const who = await (await adminFetch('whoami')).json();
        if (!who?.isAdmin) {
          setState('forbidden');
          return;
        }
        setEmail(who.email ?? null);
        const [kh, us] = await Promise.all([
          adminFetch('keyhealth').then((r) => r.json()),
          adminFetch('usage').then((r) => r.json()),
        ]);
        setKeys(Array.isArray(kh?.keys) ? kh.keys : []);
        setSummary(us?.summary ?? null);
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  if (state === 'loading') {
    return <div className="min-h-screen bg-neutral-950 p-8 text-neutral-300">読み込み中…</div>;
  }
  if (state === 'forbidden') {
    return (
      <div className="min-h-screen bg-neutral-950 p-8 text-neutral-300">
        <h1 className="text-lg font-bold text-white">運営ダッシュボード</h1>
        <p className="mt-2 text-sm">
          アクセス権がありません（管理者のみ）。ログイン中のアカウントのメールを、環境変数 <code>ADMIN_EMAILS</code>
          に追加すると閲覧できます。
        </p>
      </div>
    );
  }
  if (state === 'error') {
    return <div className="min-h-screen bg-neutral-950 p-8 text-red-300">読み込みに失敗しました。</div>;
  }

  return (
    <div className="min-h-screen bg-neutral-950 p-6 text-white">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-baseline justify-between">
          <h1 className="text-xl font-black">運営ダッシュボード</h1>
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
      </div>
    </div>
  );
}
