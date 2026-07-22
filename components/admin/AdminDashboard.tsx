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
  /** 主表示名（ユーザー別＝email/表示名、案件別＝プロジェクト名）。key は id のまま＝ドリルダウン/共有用。 */
  label?: string;
  /** 副表示（案件別＝作成ユーザー）。 */
  sublabel?: string;
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
interface UsageEvent {
  createdAt: string | null;
  feature: string | null;
  model: string | null;
  images: number;
  tokens: number;
  costUsd: number;
  costEstimated: boolean;
}
interface UserUsageResult {
  ok: boolean;
  reason?: string;
  user: { id: string; email: string | null; displayName: string | null };
  events: UsageEvent[];
  totalEvents: number;
  totalCostUsd: number;
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

const JPY_PER_USD = 160; // 為替の概算表示レート（⑩・時価連動でなく少し高めの固定・要調整）。
const yen = (usd: number) => `約¥${Math.round(usd * JPY_PER_USD).toLocaleString('ja-JP')}`;
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

function GroupTable({
  title,
  rows,
  note,
  keyHeader = 'キー',
  onRowClick,
  onOpen,
  openingKey,
}: {
  title: string;
  rows: GroupAgg[];
  note?: string;
  keyHeader?: string;
  /** 設定するとキー列がクリック可能になり、その行のドリルダウンを開く（ユーザー別で使用）。 */
  onRowClick?: (row: GroupAgg) => void;
  /** 設定すると各行に「開く」ボタンを出し、その案件を読み取り専用で開く（案件別で使用・⑤）。 */
  onOpen?: (row: GroupAgg) => void;
  /** いま開いている最中の行 key（ボタンを「開いています…」に）。 */
  openingKey?: string | null;
}) {
  // 表示名があればそれを、無ければ UUID を短縮表示（誰か分かるように）。
  const shownKey = (r: GroupAgg): string =>
    r.label ?? (r.key.length > 40 ? `${r.key.slice(0, 8)}…${r.key.slice(-6)}` : r.key);
  const cols = 5 + (onOpen ? 1 : 0);
  return (
    <Card>
      <h3 className="mb-2 text-sm font-bold text-emerald-300">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-neutral-400">
            <tr className="text-left">
              <th className="py-1 pr-3 font-semibold">{keyHeader}</th>
              <th className="py-1 pr-3 text-right font-semibold">回数</th>
              <th className="py-1 pr-3 text-right font-semibold">画像</th>
              <th className="py-1 pr-3 text-right font-semibold">トークン</th>
              <th className="py-1 text-right font-semibold">概算費用</th>
              {onOpen && <th className="py-1 pl-3 text-right font-semibold">操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols} className="py-2 text-neutral-500">
                  データがありません（計測開始後に集計されます）。
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-white/5 align-top">
                <td className="py-1 pr-3 break-words text-neutral-200">
                  {onRowClick ? (
                    <button
                      type="button"
                      onClick={() => onRowClick(r)}
                      title="このユーザーの利用履歴を表示"
                      className="text-left text-emerald-300 underline decoration-dotted underline-offset-2 hover:text-emerald-200"
                    >
                      {shownKey(r)}
                    </button>
                  ) : (
                    <span className={r.label ? 'text-neutral-200' : 'font-mono text-[11px]'}>{shownKey(r)}</span>
                  )}
                  {r.sublabel && <div className="text-[10px] text-neutral-500">作成: {r.sublabel}</div>}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{r.events.toLocaleString('ja-JP')}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{r.images.toLocaleString('ja-JP')}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{r.tokens.toLocaleString('ja-JP')}</td>
                <td className="py-1 text-right tabular-nums">
                  {yen(r.costUsd)}
                  {r.costEstimated && <span className="ml-1 text-amber-400" title="単価未登録の行を含む概算">*</span>}
                </td>
                {onOpen && (
                  <td className="py-1 pl-3 text-right">
                    <button
                      type="button"
                      onClick={() => onOpen(r)}
                      disabled={openingKey === r.key}
                      title="この案件を読み取り専用で開く"
                      className="whitespace-nowrap rounded-md border border-white/10 bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 transition hover:border-emerald-400 disabled:opacity-40"
                    >
                      {openingKey === r.key ? '開いています…' : '開く'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="mt-2 text-[11px] text-neutral-500">{note}</p>}
    </Card>
  );
}

/** 機能コード（ai_usage_events.feature）を日本語表示に（⑩・5機能を分けて表示）。 */
const FEATURE_LABELS: Record<string, string> = {
  render: 'AIレンダリング',
  ai_edit: 'エリア編集', // クライアント確認: 従来「AI画像編集」表記＝エリア編集のこと
  ai_coordinate: 'コーディネート',
  agent: 'エージェントに相談',
  export: '高解像度書き出し',
  ai_design: 'AIデザイン提案', // 参考（利用計測には通常現れない）
};
const featureLabel = (f: string | null): string => (f ? FEATURE_LABELS[f] ?? f : '—');

/** 1ユーザーの利用履歴ドリルダウン（モーダル・G2）。 */
function UserUsageModal({
  data,
  loading,
  fallbackId,
  onClose,
}: {
  data: UserUsageResult | null;
  loading: boolean;
  fallbackId: string;
  onClose: () => void;
}) {
  const title = data?.user.email || data?.user.displayName || fallbackId;
  return (
    <div
      className="fixed inset-0 z-[10050] flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-white/10 bg-neutral-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-emerald-300">利用履歴</h3>
            <div className="truncate text-sm font-bold text-white">{title}</div>
            {data?.user.displayName && data.user.email && (
              <div className="truncate text-[11px] text-neutral-400">{data.user.displayName}</div>
            )}
            <div className="truncate font-mono text-[10px] text-neutral-500">{data?.user.id || fallbackId}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-neutral-700"
          >
            閉じる
          </button>
        </div>

        {loading ? (
          <p className="mt-4 text-xs text-neutral-400">読み込み中…</p>
        ) : !data?.ok ? (
          <p className="mt-4 text-xs text-amber-300">取得に失敗しました{data?.reason ? `（${data.reason}）` : ''}。</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-neutral-300">
              <span>合計 <b className="tabular-nums">{data.totalEvents.toLocaleString('ja-JP')}</b> 回</span>
              <span>概算費用 <b>{yen(data.totalCostUsd)}</b>（{usd(data.totalCostUsd)}）</span>
            </div>
            <div className="mt-3 max-h-[55vh] overflow-y-auto scroll-dark rounded-lg border border-white/10">
              <table className="w-full min-w-[560px] text-xs">
                <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
                  <tr className="text-left">
                    <th className="px-3 py-1.5 font-semibold">日時</th>
                    <th className="px-3 py-1.5 font-semibold">機能</th>
                    <th className="px-3 py-1.5 font-semibold">モデル</th>
                    <th className="px-3 py-1.5 text-right font-semibold">画像</th>
                    <th className="px-3 py-1.5 text-right font-semibold">トークン</th>
                    <th className="px-3 py-1.5 text-right font-semibold">概算費用</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-2 text-neutral-500">
                        この期間の利用履歴はありません。
                      </td>
                    </tr>
                  )}
                  {data.events.map((e, i) => (
                    <tr key={i} className="border-t border-white/5">
                      <td className="whitespace-nowrap px-3 py-1.5 text-neutral-300">{fmtDate(e.createdAt)}</td>
                      <td className="px-3 py-1.5 text-neutral-200">{featureLabel(e.feature)}</td>
                      <td className="px-3 py-1.5 font-mono text-[10px] break-all text-neutral-400">{e.model ?? '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{e.images.toLocaleString('ja-JP')}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{e.tokens.toLocaleString('ja-JP')}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {yen(e.costUsd)}
                        {e.costEstimated && <span className="ml-1 text-amber-400" title="単価未登録">*</span>}
                        <div className="text-[10px] text-neutral-500">{usd(e.costUsd)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-neutral-500">
              最新 {data.events.length.toLocaleString('ja-JP')} 件を表示（費用は実測トークン×公式単価の概算。* は単価未登録）。
            </p>
          </>
        )}
      </div>
    </div>
  );
}

interface RegRequest {
  id: string;
  email: string;
  name: string | null;
  status: string;
  deviceUa: string | null;
  deviceScreen: string | null;
  ip: string | null;
  createdAt: string | null;
}

/** 登録リクエスト（#2 再設計・260716）の一覧・承認（招待リンク送信）・却下。 */
function RegistrationRequestsCard() {
  const [requests, setRequests] = useState<RegRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // 一覧取得の失敗は msg と分けて持つ（エラー時に「未処理のリクエストはありません」と同時表示して誤解させないため・260716 検証）。
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setMsg(null);
    setLoadError(null);
    try {
      const res = await adminFetch('list-requests&status=pending');
      const r = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(r?.requests)) {
        // fetch は HTTP エラーで throw しないため res.ok を明示的に確認し、空表示で誤解させない。
        setRequests([]);
        setLoadError(`一覧の取得に失敗しました（${r?.error ?? res.status}）。`);
      } else {
        setRequests(r.requests);
      }
    } catch {
      setRequests([]);
      setLoadError('一覧の取得に失敗しました（通信エラー）。');
    }
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);

  const decide = async (id: string, action: 'approve-request' | 'reject-request') => {
    setBusyId(id);
    setMsg(null);
    try {
      const r = await (await adminFetch(`${action}&id=${encodeURIComponent(id)}`, 'POST')).json();
      if (r?.success) {
        setRequests((prev) => prev.filter((x) => x.id !== id));
        setMsg(action === 'approve-request' ? '承認して招待リンクを送信しました。' : '却下しました。');
      } else {
        setMsg(`操作に失敗しました（${r?.error ?? 'error'}）。`);
      }
    } catch {
      setMsg('通信エラーが発生しました。');
    }
    setBusyId(null);
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-emerald-300">登録リクエスト（未処理）</h3>
        <button type="button" onClick={() => void load()} className="text-[11px] text-neutral-400 transition hover:text-neutral-200">
          更新
        </button>
      </div>
      <p className="mb-3 mt-1 text-[11px] text-neutral-500">
        承認すると、そのメールアドレス宛に招待リンクを送信します（本登録へ誘導）。却下は招待を送りません。
      </p>
      {loading ? (
        <p className="text-xs text-neutral-400">読み込み中…</p>
      ) : loadError ? (
        <p className="text-xs text-amber-300">{loadError}</p>
      ) : requests.length === 0 ? (
        <p className="text-xs text-neutral-500">未処理のリクエストはありません。</p>
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-white">
                  {r.name ? <span className="font-bold">{r.name}</span> : <span className="text-neutral-500">（名前未入力）</span>}
                  <span className="ml-2 text-[11px] text-neutral-400">{r.email}</span>
                </div>
                <div className="truncate text-[10px] text-neutral-500">
                  {fmtDate(r.createdAt)}
                  {r.ip ? ` ・ ${r.ip}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busyId === r.id}
                  onClick={() => void decide(r.id, 'approve-request')}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
                >
                  承認
                </button>
                <button
                  type="button"
                  disabled={busyId === r.id}
                  onClick={() => void decide(r.id, 'reject-request')}
                  className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-white/10 disabled:opacity-40"
                >
                  却下
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="mt-2 text-[11px] text-neutral-400">{msg}</p>}
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
  // 期間フィルタ（G3）: 空=全期間。日付のみ（from は 00:00、to は 23:59:59 を送る）。
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  // 実際に集計へ反映済みの期間（＝いま表に出ている条件）。ドリルダウンはこちらを使い、
  // 入力しただけ（未適用）の値との食い違いを防ぐ。
  const [applied, setApplied] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [usageBusy, setUsageBusy] = useState(false);
  // ユーザー別ドリルダウン（G2）。
  const [drillId, setDrillId] = useState<string | null>(null);
  const [drillData, setDrillData] = useState<UserUsageResult | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  // 案件の1クリック閲覧（⑤）。
  const [openingProjectKey, setOpeningProjectKey] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  // from/to（日付のみ）を API 用の ISO クエリ文字列へ。日付のみ入力を日の境界へ広げる。空はそのまま空。
  const rangeParamsFor = (from: string, to: string): string => {
    const p = new URLSearchParams();
    if (from) p.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) p.set('to', new Date(`${to}T23:59:59`).toISOString());
    const s = p.toString();
    return s ? `&${s}` : '';
  };

  // 集計を（期間指定で）取得し直す。成功時に applied を確定する。
  const loadUsage = async (from = fromDate, to = toDate) => {
    setUsageBusy(true);
    try {
      const us = await (await adminFetch(`usage${rangeParamsFor(from, to)}`)).json();
      setSummary(us?.summary ?? null);
      setApplied({ from, to });
    } catch {
      // 失敗時は既存表示を保持（summary/applied は据え置き）。
    } finally {
      setUsageBusy(false);
    }
  };

  // ユーザー別行クリック → その人の履歴を取得（表と同じ＝適用済みの期間フィルタを適用）。
  const openUserDrill = async (row: GroupAgg) => {
    setDrillId(row.key);
    setDrillData(null);
    setDrillLoading(true);
    const fallback = (reason: string): UserUsageResult => ({
      ok: false,
      reason,
      user: { id: row.key, email: null, displayName: row.label ?? null },
      events: [],
      totalEvents: 0,
      totalCostUsd: 0,
    });
    try {
      const q = `user-usage&userId=${encodeURIComponent(row.key)}${rangeParamsFor(applied.from, applied.to)}`;
      const j = await (await adminFetch(q)).json();
      setDrillData(j?.usage ?? fallback(j?.error ?? 'error'));
    } catch {
      setDrillData(fallback('通信エラー'));
    } finally {
      setDrillLoading(false);
    }
  };

  // 案件を読み取り専用で開く（⑤）。共有トークンをサーバで発行/再利用し ?share= を新規タブで開く。
  // ポップアップブロック回避のため、クリック直後に空タブを開いてから遷移先を差し込む。
  const openProjectShare = async (row: GroupAgg) => {
    setShareMsg(null);
    setOpeningProjectKey(row.key);
    const win = window.open('about:blank', '_blank');
    try {
      const j = await (await adminFetch(`share-project&projectId=${encodeURIComponent(row.key)}`, 'POST')).json();
      if (j?.success && j?.token) {
        const url = `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(j.token)}`;
        if (win) win.location.href = url;
        else setShareMsg(`閲覧リンクを発行しました（新規タブがブロックされました）: ${url}`);
      } else {
        if (win) win.close();
        setShareMsg(`案件を開けませんでした（${j?.error ?? 'error'}）。`);
      }
    } catch {
      if (win) win.close();
      setShareMsg('通信エラーで案件を開けませんでした。');
    } finally {
      setOpeningProjectKey(null);
    }
  };

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
      <div className="mx-auto max-w-7xl space-y-6">
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
            <h2 className="text-sm font-bold text-neutral-200">AI利用状況{fromDate || toDate ? '（指定期間）' : '（直近）'}</h2>
            {summary?.ok && (
              <span className="text-xs text-neutral-400">
                合計 {summary.totalEvents.toLocaleString('ja-JP')} 回 ・ 概算 {yen(summary.totalCostUsd)}（{usd(summary.totalCostUsd)}）
              </span>
            )}
          </div>

          {/* 期間フィルタ（G3）。空欄は全期間。 */}
          <Card>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-neutral-400">
                開始日
                <input
                  type="date"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="mt-0.5 block rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs text-white outline-none focus:border-emerald-500/60"
                />
              </label>
              <label className="text-[11px] text-neutral-400">
                終了日
                <input
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  className="mt-0.5 block rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs text-white outline-none focus:border-emerald-500/60"
                />
              </label>
              <button
                type="button"
                onClick={() => void loadUsage()}
                disabled={usageBusy}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
              >
                {usageBusy ? '集計中…' : '適用'}
              </button>
              {(fromDate || toDate) && (
                <button
                  type="button"
                  onClick={() => { setFromDate(''); setToDate(''); void loadUsage('', ''); }}
                  disabled={usageBusy}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10 disabled:opacity-40"
                >
                  クリア
                </button>
              )}
              <span className="text-[11px] text-neutral-500">空欄は全期間。ユーザー名をクリックすると個別の利用履歴を表示します。</span>
            </div>
          </Card>

          {!summary?.ok ? (
            <Card>
              <p className="text-xs text-neutral-400">
                集計を取得できませんでした{summary?.reason ? `（${summary.reason}）` : ''}。計測が有効化され、
                利用が発生すると表示されます。
              </p>
            </Card>
          ) : (
            // ⑥⑧: 横スクロールを無くすため、テーブルは全幅で縦に積む（左右2分割をやめる）。
            <div className="space-y-3">
              <GroupTable title="モデル別" rows={summary.byModel} keyHeader="モデル" note={summary.note} />
              <GroupTable title="ユーザー別（上位）" rows={summary.byUser} keyHeader="ユーザー" onRowClick={(r) => void openUserDrill(r)} />
              <GroupTable
                title="案件（プロジェクト）別（上位）"
                rows={summary.byProject}
                keyHeader="プロジェクト（作成ユーザー）"
                onOpen={(r) => void openProjectShare(r)}
                openingKey={openingProjectKey}
              />
              {shareMsg && <p className="text-[11px] text-amber-300 break-all">{shareMsg}</p>}
              <p className="text-[11px] text-neutral-500">
                * 印は単価が未登録の行を含む概算。¥は {JPY_PER_USD}円/$ での目安表示です。費用は実測トークン×公式単価で算出
                （Gemini画像: 入力$2/1M・画像出力$120/1M。1K/2K画像≒$0.134/枚、4K≒$0.24/枚）。専用エンジンは暫定単価×回数。
                「開く」でその案件を読み取り専用で開けます（共有機能を使わなくても閲覧可）。
              </p>
            </div>
          )}
        </section>

        {/* 運営操作: 登録リクエストの承認（#2）＋ユーザーの猶予期間管理（#4） */}
        <section className="space-y-3">
          <h2 className="text-sm font-bold text-neutral-200">運営操作</h2>
          <RegistrationRequestsCard />
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

      {/* ユーザー別ドリルダウン（G2） */}
      {drillId && (
        <UserUsageModal
          data={drillData}
          loading={drillLoading}
          fallbackId={drillId}
          onClose={() => { setDrillId(null); setDrillData(null); }}
        />
      )}
    </div>
  );
}
