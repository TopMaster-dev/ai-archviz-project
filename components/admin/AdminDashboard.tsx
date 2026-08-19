import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { getSupabase } from '../../lib/db/supabaseClient.js';
import { exitAdminDashboard } from '../../lib/admin/adminClient.js';
import { ModelFilePreview } from '../ModelFilePreview.js';
import { MODEL_UNIT_OPTIONS, unitGeometryScale, type ModelUnit } from '../../utils/modelUnit.js';
import { normalizeUprightXDeg, normalizeYawDeg } from '../../utils/modelOrientation.js';
import { DateField, PERIOD_PRESETS } from './DateRangeField.js';
import { CLOUD_VISION_FREE_UNITS_PER_MONTH } from '../../lib/admin/aiPricing.js';

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
  /** 上限に達して打ち切ったか（260731）。true のときは「一部のみ」と明示する。 */
  truncated?: boolean;
  /** Cloud Vision の消費ユニット数（260731 要望②）。 */
  visionUnits?: number;
  /** 単価表に無いモデル名（260801・費用0円で黙って合算されるのを防ぐ）。 */
  unpricedModels?: string[];
  /** Cloud Vision を最後に記録した日時（期間フィルタ非適用・計測開始の判断用）。 */
  visionLastAt?: string | null;
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

const NEW_CATEGORY_SENTINEL = '__new__';

/**
 * 公式3Dモデルを Cloudinary（3d_assets）へアップロードする（①・260726→260727）。
 * サーバ（sign-3d-upload）で署名を発行し、ブラウザから Cloudinary へ直送する（署名付き直アップロード・API Secret はサーバ内のみ）。
 * 260727: ユーザー側アップロードと同じ「向き調整プレビュー＋単位調整」＋「カテゴリ選択/新規作成」を追加。
 * 選んだ向き/単位/寸法(footprint)/カテゴリはアップロード直後に set-3d-meta で Cloudinary context へ保存し、配置・分類に反映する。
 */
function OfficialModelUploadCard({ onCategoriesChanged }: { onCategoriesChanged?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<{ publicId: string; url: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 取り込み単位・向き（ユーザー側 UploadPanel と同一仕様）。
  const [unit, setUnit] = useState<ModelUnit>('auto');
  const [uprightXDeg, setUprightXDeg] = useState(0);
  const [yawDeg, setYawDeg] = useState(0);
  const yawTouchedRef = useRef(false);
  const latestSuggestedYawRef = useRef(0);
  const handleSuggestYaw = React.useCallback((deg: number) => {
    const y = normalizeYawDeg(deg);
    latestSuggestedYawRef.current = y;
    if (!yawTouchedRef.current) setYawDeg(y);
  }, []);
  // カテゴリ選択/新規作成。
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');

  const loadCategories = React.useCallback(async () => {
    try {
      const r = await (await adminFetch('furniture-categories')).json();
      if (Array.isArray(r?.categories)) setCategories(r.categories.map((c: { name: string }) => c.name));
    } catch {
      /* 一覧取得失敗は無視（新規作成は可能） */
    }
  }, []);
  useEffect(() => { void loadCategories(); }, [loadCategories]);

  const ACCEPT = '.glb,.gltf,.fbx,.obj';
  const isAccepted = (name: string) => /\.(glb|gltf|fbx|obj)$/i.test(name);

  const resetInputs = () => {
    setUnit('auto');
    setUprightXDeg(0);
    setYawDeg(0);
    yawTouchedRef.current = false;
    latestSuggestedYawRef.current = 0;
    setSelectedCategory('');
    setNewCategory('');
  };

  // 選んだ向き/単位で footprint(mm) をクライアント計測（ユーザー側 ensureUploadFootprint と同じ計算・FBX/OBJ も可）。
  const computeFootprint = async (f: File): Promise<{ width: number; depth: number } | null> => {
    try {
      const dot = f.name.lastIndexOf('.');
      const ext = dot >= 0 ? f.name.slice(dot + 1).toLowerCase() : '';
      const raw = URL.createObjectURL(f);
      const measureUrl = ext ? `${raw}#${ext}` : raw; // #ext はローダの形式判定に必須（fbx/obj）。
      try {
        const { computeGltfFootprintBaseMm } = await import('../../utils/furnitureModelFootprint.js');
        const dims = await computeGltfFootprintBaseMm(measureUrl, unitGeometryScale(unit), normalizeUprightXDeg(uprightXDeg));
        return dims && Number.isFinite(dims.width) && Number.isFinite(dims.depth) ? { width: dims.width, depth: dims.depth } : null;
      } finally {
        URL.revokeObjectURL(raw);
      }
    } catch {
      return null; // 計測失敗時は footprint 無しで続行（向き/カテゴリは保存される）。
    }
  };

  const chosenCategory = (): string =>
    (selectedCategory === NEW_CATEGORY_SENTINEL ? newCategory : selectedCategory).trim();

  const upload = async () => {
    if (!file) return;
    if (!isAccepted(file.name)) {
      setMsg('対応形式は FBX / GLB / GLTF / OBJ です。');
      return;
    }
    setBusy(true);
    setMsg(null);
    setResult(null);
    try {
      // 1) サーバで署名発行（API Secret はサーバ内のみ）。
      const signRes = await adminFetch('sign-3d-upload', 'POST');
      const sign = await signRes.json().catch(() => null);
      if (!signRes.ok || !sign?.success) {
        setMsg(`署名の取得に失敗しました（${sign?.error ?? signRes.status}）。`);
        return;
      }
      // 2) ブラウザ → Cloudinary へ直アップロード（raw）。folder は preset が固定するため送らない。
      const form = new FormData();
      form.append('file', file);
      form.append('api_key', sign.apiKey);
      form.append('timestamp', String(sign.timestamp));
      form.append('signature', sign.signature);
      form.append('upload_preset', sign.uploadPreset);
      const up = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(sign.cloudName)}/raw/upload`, {
        method: 'POST',
        body: form,
      });
      const upJson = await up.json().catch(() => null);
      if (!up.ok || !upJson?.public_id) {
        setMsg(`アップロードに失敗しました（${upJson?.error?.message ?? up.status}）。`);
        return;
      }
      const publicId = String(upJson.public_id);
      setResult({ publicId, url: String(upJson.secure_url ?? '') });

      // 3) 向き/単位/footprint/カテゴリを Cloudinary context へ保存（set-3d-meta・best-effort）。
      const fp = await computeFootprint(file);
      const params = new URLSearchParams({ publicId });
      if (fp) { params.set('widthMm', String(Math.round(fp.width))); params.set('depthMm', String(Math.round(fp.depth))); }
      params.set('forwardYawDeg', String(normalizeYawDeg(yawDeg)));
      params.set('uprightXDeg', String(normalizeUprightXDeg(uprightXDeg)));
      const us = unitGeometryScale(unit);
      if (us != null) { params.set('unitScale', String(us)); params.set('unit', unit); }
      const cat = chosenCategory();
      if (cat) params.set('category', cat);
      let metaOk = true;
      try {
        const metaRes = await adminFetch(`set-3d-meta&${params.toString()}`, 'POST');
        metaOk = metaRes.ok;
      } catch {
        metaOk = false;
      }

      setMsg(
        (metaOk
          ? `アップロードし、向き・単位${cat ? `・カテゴリ「${cat}」` : ''}を保存しました。`
          : 'アップロードは成功しましたが、向き/カテゴリの保存に失敗しました（既定の向きで表示されます）。') +
          ' 家具カタログ（/api/furniture）に反映されます（エディタの再読込で反映）。サムネイルは初回表示時に自動生成されます。',
      );
      if (cat) { void loadCategories(); onCategoriesChanged?.(); }
      setFile(null);
      resetInputs();
      if (inputRef.current) inputRef.current.value = '';
    } catch {
      setMsg('通信エラーが発生しました。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h3 className="mb-1 text-sm font-bold text-emerald-300">公式3Dモデルのアップロード（Cloudinary）</h3>
      <p className="mb-3 text-[11px] leading-relaxed text-neutral-500">
        FBX / GLB / GLTF / OBJ を公式カタログ（Cloudinary の <span className="font-mono">3d_assets</span>）へ直接アップロードします。
        署名はサーバ側で発行（API Secret 非露出）。向き・単位・カテゴリを調整してから保存でき、配置時の向き/サイズ合わせが正しくなります。
        ※一般ユーザーのアップロードは Supabase 管理で、この公式領域とは分離されています。
      </p>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setResult(null);
          setMsg(null);
          resetInputs();
        }}
        className="text-xs text-neutral-300 file:mr-2 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-neutral-200 hover:file:bg-neutral-700"
      />

      {file && (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          {/* 向き調整プレビュー（ユーザー側と同一の ModelFilePreview を再利用）。 */}
          <ModelFilePreview
            file={file}
            unit={unit}
            uprightXDeg={uprightXDeg}
            yawDeg={yawDeg}
            onSuggestYaw={handleSuggestYaw}
            className="h-56 w-full shrink-0 rounded-lg border border-white/10 sm:w-56"
          />
          <div className="flex flex-1 flex-col gap-2.5">
            {/* 取り込み単位 */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold text-neutral-400">取り込み単位</span>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as ModelUnit)}
                className="rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-[11px] font-semibold text-neutral-200 outline-none focus:border-emerald-500"
              >
                {MODEL_UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            {/* 向き（縦/横に回転・壁向き自動） */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold text-neutral-400">向き</span>
              <button type="button" onClick={() => setUprightXDeg((d) => normalizeUprightXDeg(d + 90))} className="rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-[11px] font-semibold text-neutral-200 transition hover:border-emerald-500 hover:text-white">縦に回転（{normalizeUprightXDeg(uprightXDeg)}°）</button>
              <button type="button" onClick={() => { yawTouchedRef.current = true; setYawDeg((d) => normalizeYawDeg(d + 90)); }} className="rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-[11px] font-semibold text-neutral-200 transition hover:border-emerald-500 hover:text-white">横に回転（{normalizeYawDeg(yawDeg)}°）</button>
              <button type="button" onClick={() => { yawTouchedRef.current = false; setYawDeg(normalizeYawDeg(latestSuggestedYawRef.current)); }} className="rounded-lg border border-emerald-600/60 bg-emerald-600/15 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 transition hover:bg-emerald-600/25">壁向きを自動</button>
            </div>
            {/* カテゴリ選択 / 新規作成 */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold text-neutral-400">カテゴリ</span>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-[11px] font-semibold text-neutral-200 outline-none focus:border-emerald-500"
              >
                <option value="">（未分類）</option>
                {categories.map((c) => (<option key={c} value={c}>{c}</option>))}
                <option value={NEW_CATEGORY_SENTINEL}>＋ 新規カテゴリを追加</option>
              </select>
              {selectedCategory === NEW_CATEGORY_SENTINEL && (
                <input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="新しいカテゴリ名"
                  className="rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-[11px] text-neutral-100 outline-none focus:border-emerald-500"
                />
              )}
            </div>
            <p className="text-[10px] leading-relaxed text-neutral-500">
              ※「縦に回転」で寝ている/上下逆を立て、「横に回転」で正面を調整。プレビューはドラッグで回転・拡大でき、軸ギズモと床グリッドで前後・上下を確認できます。
            </p>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void upload()}
          disabled={busy || !file}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
        >
          {busy ? 'アップロード中…' : 'この内容でアップロード'}
        </button>
        {file && !busy && (
          <span className="text-[11px] text-neutral-400">選択中: {file.name}（{(file.size / 1024 / 1024).toFixed(1)}MB）</span>
        )}
      </div>
      {result && <p className="mt-2 break-all text-[11px] text-emerald-300">保存済み public_id: {result.publicId}</p>}
      {msg && <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">{msg}</p>}
    </Card>
  );
}

/**
 * 既存カテゴリの管理（#4・260727）: 改名と「削除（＝解除）」。削除はアセットを消さず category を外すだけで、
 * 対象は自動分類（ファイル名推定）へ戻る＝データ消失なし。
 */
function CategoryManagerCard({ reloadSignal, onChanged }: { reloadSignal: number; onChanged?: () => void }) {
  const [cats, setCats] = useState<Array<{ name: string; count: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await (await adminFetch('furniture-categories')).json();
      if (Array.isArray(r?.categories)) setCats(r.categories.filter((c: { count: number }) => c.count > 0));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => { void load(); }, [load, reloadSignal]);

  const doRename = async (from: string) => {
    const to = (renameTo[from] ?? '').trim();
    if (!to || to === from) return;
    setBusy(from);
    setMsg(null);
    try {
      const r = await (await adminFetch(`rename-3d-category&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, 'POST')).json();
      setMsg(
        !r?.success
          ? `改名に失敗しました（${r?.error ?? 'error'}）。`
          : r.failed > 0
            ? `一部の更新に失敗しました（成功 ${r.updated ?? 0}件 / 失敗 ${r.failed}件）。Cloudinary の設定・接続をご確認ください。`
            : `「${from}」→「${to}」に改名しました（${r.updated ?? 0}件）。`,
      );
      setRenameTo((m) => ({ ...m, [from]: '' }));
      await load();
      onChanged?.();
    } catch {
      setMsg('通信エラーが発生しました。');
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async (name: string) => {
    if (!window.confirm(`カテゴリ「${name}」を削除しますか？\n※3Dモデル自体は削除されません。該当モデルは自動分類（ファイル名推定）に戻ります。`)) return;
    setBusy(name);
    setMsg(null);
    try {
      const r = await (await adminFetch(`delete-3d-category&category=${encodeURIComponent(name)}`, 'POST')).json();
      setMsg(
        !r?.success
          ? `解除に失敗しました（${r?.error ?? 'error'}）。`
          : r.failed > 0
            ? `一部の解除に失敗しました（成功 ${r.updated ?? 0}件 / 失敗 ${r.failed}件）。Cloudinary の設定・接続をご確認ください。`
            : `カテゴリ「${name}」を解除しました（${r.updated ?? 0}件は自動分類へ）。`,
      );
      await load();
      onChanged?.();
    } catch {
      setMsg('通信エラーが発生しました。');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-emerald-300">カテゴリの管理（公式カタログ）</h3>
        <button type="button" onClick={() => void load()} className="text-[11px] text-neutral-400 transition hover:text-neutral-200">更新</button>
      </div>
      <p className="mb-3 mt-1 text-[11px] leading-relaxed text-neutral-500">
        管理者が割り当てたカテゴリの改名・削除ができます。「削除」はモデルを消さず、割り当てを外して自動分類へ戻すだけです。
      </p>
      {cats.length === 0 ? (
        <p className="text-[11px] text-neutral-500">割り当て済みカテゴリはありません（アップロード時にカテゴリを指定すると表示されます）。</p>
      ) : (
        <ul className="space-y-2">
          {cats.map((c) => (
            <li key={c.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <span className="text-sm text-white">{c.name} <span className="text-[11px] text-neutral-500">（{c.count}件）</span></span>
              <div className="flex items-center gap-1.5">
                <input
                  value={renameTo[c.name] ?? ''}
                  onChange={(e) => setRenameTo((m) => ({ ...m, [c.name]: e.target.value }))}
                  placeholder="新しい名前"
                  className="w-28 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-[11px] text-white outline-none focus:border-emerald-500/60"
                />
                <button type="button" disabled={busy === c.name || !(renameTo[c.name] ?? '').trim()} onClick={() => void doRename(c.name)} className="rounded-md border border-white/10 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:border-emerald-400 disabled:opacity-40">改名</button>
                <button type="button" disabled={busy === c.name} onClick={() => void doDelete(c.name)} className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-200 hover:border-red-400 disabled:opacity-40">削除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="mt-2 text-[11px] text-neutral-400">{msg}</p>}
    </Card>
  );
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
  // 【案1・260818】画像モデルの固定状況。preview 版のままだと提供元の更新で挙動が変わりうる。
  const [imageModel, setImageModel] = useState<{
    current: { resolved: string; source: 'env' | 'default'; unstable: boolean; envVar: string };
    available: Array<{ id: string; displayName: string; unstable: boolean }>;
    note?: string;
  } | null>(null);
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
  // 公式カタログのカテゴリ変更（アップロード時の新規/管理カードの改名・削除）で相互にリロードさせる信号（260727）。
  const [catReload, setCatReload] = useState(0);

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
        const [kh, us, inf, im] = await Promise.all([
          adminFetch('keyhealth').then((r) => r.json()),
          adminFetch('usage').then((r) => r.json()),
          adminFetch('infra').then((r) => r.json()),
          adminFetch('image-models').then((r) => r.json()).catch(() => null),
        ]);
        setKeys(Array.isArray(kh?.keys) ? kh.keys : []);
        setSummary(us?.summary ?? null);
        setInfra(inf?.infra ?? null);
        setImageModel(im?.current ? { current: im.current, available: im.available ?? [], note: im.note } : null);
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

        {/* 【案1・260818】画像モデルの固定状況。 */}
        {imageModel && (
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-neutral-200">画像生成モデル</h2>
            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{imageModel.current.resolved}</span>
                <span
                  className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                    imageModel.current.unstable ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  {imageModel.current.unstable ? 'preview版（提供元都合で挙動が変わりうる）' : '安定版'}
                </span>
                <span className="rounded bg-neutral-700/50 px-2 py-0.5 text-[11px] text-neutral-300">
                  {imageModel.current.source === 'env' ? 'env で固定済み' : 'コード既定（未固定）'}
                </span>
              </div>
              {imageModel.current.unstable && (
                <div className="mt-2 text-[11px] text-amber-200/80">
                  preview 版はコードを変更しなくても生成結果の傾向が変わることがあります。
                  下の一覧から安定版を選び、環境変数 <span className="font-mono">{imageModel.current.envVar}</span> に設定して固定してください（再デプロイのみ・コード変更不要）。
                </div>
              )}
              {imageModel.note && <div className="mt-2 text-[11px] text-neutral-500">{imageModel.note}</div>}
              {imageModel.available.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] text-neutral-400">このキーで使える画像モデル</div>
                  <ul className="mt-1 space-y-1">
                    {imageModel.available.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-[11px]">
                        <span className="font-mono text-neutral-200">{m.id}</span>
                        {m.unstable ? (
                          <span className="text-amber-300/80">preview</span>
                        ) : (
                          <span className="text-emerald-300/80">安定</span>
                        )}
                        {m.id === imageModel.current.resolved && <span className="text-neutral-400">← 使用中</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </section>
        )}

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
            {/* 「直近」ではなく全期間を数えるようになった（260731・1,000件打ち切りの修正）。 */}
            <h2 className="text-sm font-bold text-neutral-200">AI利用状況{fromDate || toDate ? '（指定期間）' : '（全期間）'}</h2>
            {summary?.ok && (
              <span className="text-xs text-neutral-400">
                合計 {summary.totalEvents.toLocaleString('ja-JP')} 回 ・ 概算 {yen(summary.totalCostUsd)}（{usd(summary.totalCostUsd)}）
              </span>
            )}
          </div>

          {/* 件数が上限を超えた場合は黙って少なく見せない（この不具合の再発を必ず気付けるようにする）。 */}
          {summary?.ok && summary.truncated && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-bold text-amber-300">
              件数が上限に達したため、この集計は期間内の一部のみです。期間を短く指定してください。
            </div>
          )}

          {/* 期間フィルタ（G3）。空欄は全期間。 */}
          <Card>
            <div className="flex flex-wrap items-end gap-2">
              <DateField label="開始日" value={fromDate} max={toDate || undefined} onChange={setFromDate} testId="usage-from" />
              <DateField label="終了日" value={toDate} min={fromDate || undefined} onChange={setToDate} testId="usage-to" />
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
            {/* よく使う期間は1クリックで（請求確認は「今月」「先月」が大半・260731）。押した時点で集計まで走らせる。 */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-neutral-500">よく使う期間:</span>
              {PERIOD_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={usageBusy}
                  onClick={() => {
                    const [f, t] = p.range(new Date());
                    setFromDate(f);
                    setToDate(t);
                    void loadUsage(f, t);
                  }}
                  className="rounded-md border border-white/10 bg-[#111] px-2.5 py-1 text-[11px] text-neutral-300 transition hover:border-emerald-500/60 hover:text-white disabled:opacity-40"
                >
                  {p.label}
                </button>
              ))}
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
              {/*
                Cloud Vision は「無料枠に収まっていて表示されない」のか「そもそも数えていない」のかを
                区別できるようにする（260731 クライアント要望②）。0回でも行として出す。
              */}
              <Card>
                <h3 className="mb-2 text-sm font-bold text-emerald-300">Cloud Vision API（画像から商品を特定）</h3>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-neutral-200">
                  <span>
                    消費ユニット <b className="tabular-nums">{(summary.visionUnits ?? 0).toLocaleString('ja-JP')}</b>
                  </span>
                  <span className="text-neutral-400">
                    無料枠 月 {CLOUD_VISION_FREE_UNITS_PER_MONTH.toLocaleString('ja-JP')} ユニットまで
                  </span>
                  <span className="text-neutral-400">
                    超過分の単価 $3.50 / 1,000 ユニット（WEB_DETECTION）
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-neutral-500">
                  1回の操作で複数ユニットを消費します（画像1枚の解析＋類似画像からの再検索・最大3ユニット）。
                  上の「モデル別」に出る金額は無料枠を引く前の総額です。
                </p>
                {/*
                  0 が「使われていない」のか「まだ数え始めていない」のかを区別できるようにする（260801）。
                  Vision の計測は 2026/07/30 に実装したため、それ以前を指定すると必ず 0 になる。
                */}
                <p className="mt-1 text-[11px] text-neutral-500">
                  計測開始 2026/07/30。
                  {summary.visionLastAt
                    ? `最終記録 ${new Date(summary.visionLastAt).toLocaleString('ja-JP')}（期間指定を問わない全体の最新）。`
                    : '記録はまだ1件もありません（計測開始より前の利用は集計できません）。'}
                </p>
              </Card>
              {/* 単価未登録は費用0円で黙って合算されるため、必ず名前を出す（260801）。 */}
              {summary.unpricedModels && summary.unpricedModels.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                  <b>単価が未登録のモデルがあります</b>（費用0円として合算されているため、実請求より少なく表示されます）:{' '}
                  <span className="font-mono">{summary.unpricedModels.join(', ')}</span>
                </div>
              )}
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
          <OfficialModelUploadCard onCategoriesChanged={() => setCatReload((n) => n + 1)} />
          <CategoryManagerCard reloadSignal={catReload} onChanged={() => setCatReload((n) => n + 1)} />
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
