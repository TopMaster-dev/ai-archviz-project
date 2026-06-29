import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../lib/auth/AuthContext.js';
import {
  ACCEPTED_EXT,
  checkStorageCapacity,
  deleteUserUpload,
  getStorageUsageSelf,
  listUserUploads,
  notifyStorageWarningSelf,
  STORAGE_SOFT_LIMIT_BYTES,
  STORAGE_WARN_FRACTION,
  STORAGE_WARN_THRESHOLD_BYTES,
  updateUserUploadMetadata,
  uploadUserFile,
  type StorageUsage,
  type UploadKind,
  type UserUpload,
} from '../lib/db/uploads.js';
import type { MaterialCategory } from '../types.js';
import {
  TEXTURE_CATEGORY_OPTIONS,
  normalizeTextureCategory,
  textureCategoryLabel,
} from '../lib/uploadsCatalog.js';
import { useProjectStore } from '../lib/store/projectStore.js';
import { useConfirm } from './ConfirmDialog.js';

/**
 * 削除したテクスチャを壁/床/天井などに割り当て済みなら、その割当を既定（null）へ戻す。
 * 割当（selections）には Product がスナップショットで埋め込まれており textureUrl=storageUrl が
 * 404 化するため、現在ストアに読み込まれているプロジェクトから当該割当を取り除く。
 * （描画側にもフォールバックがあるため、ここでの失敗は致命ではない。）
 */
function scrubDeletedTextureFromProject(upload: UserUpload): void {
  try {
    if (upload.kind !== 'texture') return;
    const deletedProductId = `upload-tex-${upload.id}`;
    const store = useProjectStore.getState();
    const selections = store.materials.selections;
    let changed = false;
    const next: typeof selections = {};
    for (const [meshName, product] of Object.entries(selections)) {
      if (product && (product.id === deletedProductId || product.textureUrl === upload.storageUrl)) {
        next[meshName] = null;
        changed = true;
      } else {
        next[meshName] = product;
      }
    }
    if (changed) store.setSelections(next);
  } catch {
    /* スクラブ失敗は致命ではない（描画側の既定マテリアルで表示される） */
  }
}

/**
 * 「マイアップロード」管理パネル（ホーム画面）。
 * ユーザーが独自の 3D モデル / 建材画像（テクスチャ）を Supabase Storage へアップロードし、
 * 一覧・削除できる。実体は Storage、所在/メタは user_uploads 台帳に記録され、
 * 管理画面（service_role）から全件把握できる（クライアント要望 #6）。
 *
 * 260623 クライアント要望:
 *  - 「＋ 建材を追加（画像）」を押す → ファイル選択 → 選んだ画像のカテゴリ（共通/壁/床/天井）を
 *    ポップアップで選ばせてから追加する（事前のカテゴリタブ選択をやめる）。
 *  - 過去のマイアップロード一覧は既定で折りたたみ、「▶ 過去のマイアップロードデータの表示」で開く。
 */

function fmtBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

const KIND_LABEL: Record<UploadKind, string> = { model: '3Dモデル', texture: 'テクスチャ' };

export function UploadPanel({
  onUploadsChanged,
  refreshSignal,
}: { onUploadsChanged?: () => void; refreshSignal?: number } = {}) {
  const { configured } = useAuth();
  const confirm = useConfirm();
  const [uploads, setUploads] = useState<UserUpload[]>([]);
  // 使用量はバケット実体の合計（AI生成画像を含む・RPC）。未適用環境では null→台帳合計にフォールバック。
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  // アップロード進捗（0〜1・取得不可な環境では null=不確定表示）と対象ファイル名（大きいファイルのローディング表示・260629）。
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKind, setBusyKind] = useState<UploadKind | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // 過去のマイアップロード一覧は既定で折りたたみ（260623）。
  const [uploadsExpanded, setUploadsExpanded] = useState(false);
  // 建材画像（テクスチャ）追加: ファイル選択後にカテゴリ選択ポップアップで使う一時状態。
  const [pendingTexture, setPendingTexture] = useState<{ file: File; previewUrl: string } | null>(null);
  const [pendingCategory, setPendingCategory] = useState<MaterialCategory | null>(null);

  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const textureInputRef = useRef<HTMLInputElement | null>(null);

  // 使用量（バケット実体）の再取得。アップロード/削除/初期表示後に呼ぶ。最新値を返す。
  const refreshUsage = async (): Promise<StorageUsage | null> => {
    try {
      const u = await getStorageUsageSelf();
      setUsage(u);
      return u;
    } catch {
      setUsage(null); // 失敗時は台帳合計にフォールバック
      return null;
    }
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const [list] = await Promise.all([listUserUploads(), refreshUsage()]);
      setUploads(list);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '一覧の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!configured) return;
    void refresh();
    // refreshSignal が変わったら（完全削除等の後）一覧＋使用量を取り直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, refreshSignal]);

  // ポップアップを閉じる/差し替える/アンマウント時にプレビュー用 ObjectURL を解放する。
  useEffect(() => {
    if (!pendingTexture) return;
    return () => URL.revokeObjectURL(pendingTexture.previewUrl);
  }, [pendingTexture]);

  const handlePick = (kind: UploadKind) => {
    setMsg(null);
    (kind === 'model' ? modelInputRef : textureInputRef).current?.click();
  };

  // 実アップロード（モデルは即時、テクスチャはポップアップ確定後）。
  const doUpload = async (file: File, kind: UploadKind, category: MaterialCategory | null) => {
    // 容量警告プロセス（管理表 row 31）: 本人の総容量がソフト上限に達する/超える追加はブロックする。
    const currentTotal = usage?.totalBytes ?? uploads.reduce((sum, u) => sum + (u.bytes ?? 0), 0);
    const capacityMsg = checkStorageCapacity(currentTotal, file.size);
    if (capacityMsg) {
      setMsg(capacityMsg);
      return;
    }
    setBusyKind(kind);
    setUploadingName(file.name);
    setProgress(null); // 進捗が取れる環境（XHR）では onProgress が数値をセット、取れない場合は null のまま＝不確定バー
    setMsg(null);
    try {
      // テクスチャは選択したカテゴリを metadata.category に保存（共通=未設定）。
      const metadata = kind === 'texture' && category ? { category } : undefined;
      const row = await uploadUserFile(file, kind, { metadata, onProgress: setProgress });
      setUploads((prev) => [row, ...prev]);
      const fresh = await refreshUsage(); // バケット実体の合計を更新（busy 解除前に最新化＝連続アップロードでも上限判定が古くならない）
      if (fresh && fresh.totalBytes >= STORAGE_WARN_THRESHOLD_BYTES) {
        void notifyStorageWarningSelf(); // 日次 cron を待たず即時に警告メールを依頼（サーバが SMTP/しきい値/クールダウンを判定）
      }
      const catNote = kind === 'texture' ? `（${textureCategoryLabel(category)}）` : '';
      setMsg(`「${row.originalName ?? file.name}」${catNote}をアップロードしました。`);
      if (kind === 'texture') onUploadsChanged?.(); // エディタの素材一覧へ即時反映
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'アップロードに失敗しました。');
    } finally {
      setBusyKind(null);
      setProgress(null);
      setUploadingName(null);
    }
  };

  // 3Dモデルは選択後すぐにアップロード。
  const onModelPicked = (file: File | undefined) => {
    if (modelInputRef.current) modelInputRef.current.value = '';
    if (file) void doUpload(file, 'model', null);
  };

  // 建材画像（テクスチャ）は選択後、カテゴリ選択ポップアップを開く（260623）。
  const onTexturePicked = (file: File | undefined) => {
    if (textureInputRef.current) textureInputRef.current.value = '';
    if (!file) return;
    const currentTotal = usage?.totalBytes ?? uploads.reduce((sum, u) => sum + (u.bytes ?? 0), 0);
    const capacityMsg = checkStorageCapacity(currentTotal, file.size);
    if (capacityMsg) {
      setMsg(capacityMsg);
      return;
    }
    setMsg(null);
    setPendingCategory(null); // 既定=共通
    setPendingTexture({ file, previewUrl: URL.createObjectURL(file) });
  };

  const cancelPendingTexture = () => setPendingTexture(null);
  const confirmPendingTexture = async () => {
    const pending = pendingTexture;
    if (!pending) return;
    setPendingTexture(null); // ポップアップを閉じる（ObjectURL は effect が解放）
    await doUpload(pending.file, 'texture', pendingCategory);
  };

  // テクスチャのカテゴリ割当を変更（既存 metadata にマージして保存）。
  const handleChangeCategory = async (u: UserUpload, category: MaterialCategory | null) => {
    setUpdatingId(u.id);
    setMsg(null);
    try {
      const next: Record<string, unknown> = { ...u.metadata };
      if (category) next.category = category;
      else delete next.category; // 共通＝未設定
      const row = await updateUserUploadMetadata(u.id, next);
      setUploads((prev) => prev.map((x) => (x.id === u.id ? row : x)));
      if (u.kind === 'texture') onUploadsChanged?.(); // カテゴリ変更を素材一覧へ反映
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'カテゴリの変更に失敗しました。');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDelete = async (u: UserUpload) => {
    if (!(await confirm({ message: `「${u.originalName ?? 'このファイル'}」を削除しますか？`, confirmLabel: '削除', danger: true }))) return;
    setDeletingId(u.id);
    setMsg(null);
    try {
      await deleteUserUpload(u);
      // 削除したテクスチャが現在のプロジェクトの壁/床等に割り当て済みなら既定へ戻す。
      scrubDeletedTextureFromProject(u);
      setUploads((prev) => prev.filter((x) => x.id !== u.id));
      await refreshUsage(); // バケット実体の合計を更新（バー/数値）
      if (u.kind === 'texture') onUploadsChanged?.(); // 削除を素材一覧から除去
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '削除に失敗しました。');
    } finally {
      setDeletingId(null);
    }
  };

  if (!configured) {
    return (
      <div className="rounded-lg bg-neutral-900/60 p-3 text-xs text-neutral-500">
        ローカルモードではアップロード機能は利用できません（Supabase 構成時に有効）。
      </div>
    );
  }

  const busy = busyKind != null;
  // 容量警告（管理表 row 31）: 使用量はバケット実体の合計（AI生成画像を含む・RPC）。
  // RPC 未取得時は台帳合計にフォールバック（表示を壊さない）。接近で警告し、超過する追加はブロックする。
  const ledgerTotal = uploads.reduce((sum, u) => sum + (u.bytes ?? 0), 0);
  const totalBytes = usage?.totalBytes ?? ledgerTotal;
  const usagePct = Math.min(100, Math.round((totalBytes / STORAGE_SOFT_LIMIT_BYTES) * 100));
  const overLimit = totalBytes >= STORAGE_SOFT_LIMIT_BYTES;
  const nearLimit = !overLimit && usagePct >= STORAGE_WARN_FRACTION * 100;
  const fmtMB = (b: number) => (b / (1024 * 1024)).toFixed(1);

  // 色分けバー（260626 クライアント要望）: 種別ごとのバイト数を1本のバーに積む（iPhone のストレージ表示風）。
  // RPC 未取得時は台帳から model/texture のみ算出（AI生成画像は 0 表示）。
  const byKind = usage?.byKind ?? {
    model: uploads.filter((u) => u.kind === 'model').reduce((s, u) => s + (u.bytes ?? 0), 0),
    texture: uploads.filter((u) => u.kind === 'texture').reduce((s, u) => s + (u.bytes ?? 0), 0),
    aiRender: 0,
    other: 0,
  };
  const segments = [
    { key: 'model', label: '3Dモデル', bytes: byKind.model, color: 'bg-emerald-500' },
    { key: 'texture', label: 'テクスチャ画像', bytes: byKind.texture, color: 'bg-sky-500' },
    { key: 'ai', label: 'AI生成画像', bytes: byKind.aiRender, color: 'bg-violet-500' },
    { key: 'other', label: 'その他', bytes: byKind.other, color: 'bg-neutral-400' },
  ].filter((s) => s.bytes > 0);
  // バー幅の分母: 上限超過時は実合計（=セグメント合計）でフルバー、通常は上限基準。
  const barDenom = Math.max(STORAGE_SOFT_LIMIT_BYTES, totalBytes, 1);

  // アップロード中ボタンのラベル（スピナー＋進捗%）。進捗取得不可なら % は省略（260629）。
  const pctText = progress != null ? ` ${Math.round(progress * 100)}%` : '';
  const uploadingLabel = (
    <span className="inline-flex items-center justify-center gap-1.5">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      アップロード中…{pctText}
    </span>
  );

  return (
    <div className="rounded-lg bg-neutral-900/60 p-3 text-xs text-neutral-200">
      <p className="mb-1 font-semibold text-neutral-300">マイアップロード</p>
      <p className="mb-2 text-[11px] leading-snug text-neutral-500">
        独自の 3D モデル（{ACCEPTED_EXT.model.join(' / ')}）や建材画像（
        {ACCEPTED_EXT.texture.join(' / ')}）を保存できます。
      </p>

      {/* 容量警告（管理表 row 31）: 使用量バー＋接近/超過時の警告 */}
      <div className="mb-2">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="text-neutral-400">ストレージ使用量</span>
          <span className={`font-mono ${overLimit ? 'text-red-300' : nearLimit ? 'text-amber-300' : 'text-neutral-400'}`}>
            {fmtMB(totalBytes)} / {fmtMB(STORAGE_SOFT_LIMIT_BYTES)} MB
          </span>
        </div>
        {/* 色分けバー: 種別ごとに色を変えて1本に積む（AI生成画像も含む） */}
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/10">
          {segments.map((s) => (
            <div
              key={s.key}
              className={`h-full ${s.color}`}
              style={{ width: `${(s.bytes / barDenom) * 100}%` }}
              title={`${s.label} ${fmtMB(s.bytes)}MB`}
            />
          ))}
        </div>
        {/* 凡例: 色・ラベル・容量 */}
        {segments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-neutral-400">
            {segments.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className={`inline-block h-2 w-2 rounded-sm ${s.color}`} />
                {s.label} {fmtMB(s.bytes)}MB
              </span>
            ))}
          </div>
        )}
        {(overLimit || nearLimit) && (
          <p className={`mt-1 text-[10px] leading-snug ${overLimit ? 'text-red-300' : 'text-amber-300'}`}>
            {overLimit
              ? '容量の上限に達しました。不要なアップロードを削除してください。'
              : '容量の上限に近づいています。不要なアップロードの削除をご検討ください。'}
          </p>
        )}
      </div>

      <div className="mb-3 flex gap-1.5">
        <button
          type="button"
          disabled={busy || overLimit || pendingTexture != null}
          onClick={() => handlePick('model')}
          className="flex-1 rounded bg-emerald-600 py-1.5 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {busyKind === 'model' ? uploadingLabel : '＋ 3Dモデル'}
        </button>
        <button
          type="button"
          disabled={busy || overLimit || pendingTexture != null}
          onClick={() => handlePick('texture')}
          className="flex-1 rounded bg-neutral-700 py-1.5 font-semibold text-white transition hover:bg-neutral-600 disabled:opacity-50"
        >
          {busyKind === 'texture' ? uploadingLabel : '＋ 建材を追加（画像）'}
        </button>
      </div>

      {/* アップロード進捗（260629 クライアント要望: 大きいファイルで「進行中/完了」が分かるように）。 */}
      {busy && (
        <div className="mb-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-emerald-300">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span className="truncate">アップロード中…{uploadingName ? `「${uploadingName}」` : ''}</span>
            </span>
            {progress != null && (
              <span className="shrink-0 font-mono text-emerald-300">{Math.round(progress * 100)}%</span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            {progress != null ? (
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${Math.min(100, Math.max(3, Math.round(progress * 100)))}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-500/80" />
            )}
          </div>
          <p className="mt-1 text-[10px] leading-snug text-neutral-500">
            大きいファイルは時間がかかります。完了までこのままお待ちください。
          </p>
        </div>
      )}

      <input
        ref={modelInputRef}
        type="file"
        accept={ACCEPTED_EXT.model.join(',')}
        className="hidden"
        onChange={(e) => onModelPicked(e.target.files?.[0])}
      />
      <input
        ref={textureInputRef}
        type="file"
        accept={ACCEPTED_EXT.texture.join(',')}
        className="hidden"
        onChange={(e) => onTexturePicked(e.target.files?.[0])}
      />

      {msg && <p className="mb-2 text-[11px] text-neutral-400">{msg}</p>}

      {/* 過去のマイアップロード一覧（既定で折りたたみ・260623） */}
      {loading && uploads.length === 0 ? (
        <p className="text-[11px] text-neutral-500">読み込み中…</p>
      ) : uploads.length === 0 ? (
        <p className="text-[11px] text-neutral-500">まだアップロードはありません。</p>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setUploadsExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-[12px] font-semibold text-neutral-400 transition hover:text-neutral-200"
          >
            {uploadsExpanded ? '▾' : '▶'} 過去のマイアップロードデータの表示
            <span className="text-[11px] font-normal text-neutral-500">{uploads.length}</span>
          </button>
          {uploadsExpanded && (
            <ul className="mt-2 space-y-1.5">
              {uploads.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-white/10 bg-neutral-950/50 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          u.kind === 'model' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-sky-500/15 text-sky-300'
                        }`}
                      >
                        {KIND_LABEL[u.kind]}
                      </span>
                      <span className="truncate text-[11px] text-neutral-200" title={u.originalName ?? ''}>
                        {u.originalName ?? '(無題)'}
                      </span>
                    </div>
                    <span className="text-[10px] text-neutral-500">
                      {fmtBytes(u.bytes)}
                      {u.bytes != null ? ' · ' : ''}
                      {fmtDate(u.createdAt)}
                    </span>
                  </div>
                  {u.kind === 'texture' && (
                    <select
                      value={normalizeTextureCategory(u.metadata.category) ?? ''}
                      disabled={updatingId === u.id}
                      onChange={(e) =>
                        void handleChangeCategory(u, (e.target.value || null) as MaterialCategory | null)
                      }
                      title="表示カテゴリ"
                      aria-label="表示カテゴリ"
                      className="shrink-0 rounded border border-white/10 bg-neutral-800 px-1.5 py-1 text-[11px] text-neutral-200 disabled:opacity-50"
                    >
                      {TEXTURE_CATEGORY_OPTIONS.map((opt) => (
                        <option key={opt.label} value={opt.value ?? ''}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={deletingId === u.id}
                    onClick={() => void handleDelete(u)}
                    className="shrink-0 rounded px-2 py-1 text-[11px] text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
                  >
                    {deletingId === u.id ? '削除中…' : '削除'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 建材画像のカテゴリ選択ポップアップ（260623）。ファイル選択後にカテゴリを決めて追加する。 */}
      {pendingTexture && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
          onClick={cancelPendingTexture}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-white/10 bg-neutral-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="建材画像のカテゴリ選択"
          >
            <h3 className="text-base font-bold text-neutral-100">追加した建材画像のカテゴリを選択してください。</h3>
            <p className="mt-1 text-[11px] text-neutral-400">
              ※複数のカテゴリに属する場合は共通を選択してください。
            </p>

            <div className="mt-4 flex gap-4">
              <div className="h-32 w-32 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-neutral-800">
                <img src={pendingTexture.previewUrl} alt="選択された建材画像" className="h-full w-full object-cover" />
              </div>
              <div className="flex-1">
                <div className="grid grid-cols-2 gap-2">
                  {TEXTURE_CATEGORY_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => setPendingCategory(opt.value)}
                      className={`rounded-lg py-2.5 text-sm font-semibold transition ${
                        pendingCategory === opt.value
                          ? 'bg-sky-600 text-white'
                          : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelPendingTexture}
                className="rounded-lg bg-neutral-800 px-4 py-2 text-sm transition hover:bg-neutral-700"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirmPendingTexture()}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                選択したカテゴリに追加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
