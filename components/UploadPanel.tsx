import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth/AuthContext.js';
import {
  ACCEPTED_EXT,
  checkStorageCapacity,
  deleteUserUpload,
  listUserUploads,
  STORAGE_SOFT_LIMIT_BYTES,
  updateUserUploadMetadata,
  uploadUserFile,
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
 * ユーザーが独自の 3D モデル / テクスチャを Supabase Storage へアップロードし、
 * 一覧・削除できる。実体は Storage、所在/メタは user_uploads 台帳に記録され、
 * 管理画面（service_role）から全件把握できる（クライアント要望 #6）。
 *
 * エディタ取り込み（家具カタログ/素材への反映）は後続スライス #6b で対応。
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

export function UploadPanel({ onUploadsChanged }: { onUploadsChanged?: () => void } = {}) {
  const { configured } = useAuth();
  const confirm = useConfirm();
  const [uploads, setUploads] = useState<UserUpload[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKind, setBusyKind] = useState<UploadKind | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // テクスチャ追加時に割り当てるカテゴリ（null=共通=全カテゴリに表示）。
  const [texCategory, setTexCategory] = useState<MaterialCategory | null>(null);

  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const textureInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setUploads(await listUserUploads());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '一覧の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!configured) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  const handlePick = (kind: UploadKind) => {
    setMsg(null);
    (kind === 'model' ? modelInputRef : textureInputRef).current?.click();
  };

  const handleFile = async (kind: UploadKind, file: File | undefined) => {
    if (!file) return;
    // 容量警告プロセス（管理表 row 31）: 本人の総容量がソフト上限に達する/超える追加はブロックする。
    const currentTotal = uploads.reduce((sum, u) => sum + (u.bytes ?? 0), 0);
    const capacityMsg = checkStorageCapacity(currentTotal, file.size);
    if (capacityMsg) {
      setMsg(capacityMsg);
      if (modelInputRef.current) modelInputRef.current.value = '';
      if (textureInputRef.current) textureInputRef.current.value = '';
      return;
    }
    setBusyKind(kind);
    setMsg(null);
    try {
      // テクスチャは選択中のカテゴリを metadata.category に保存（共通=未設定）。
      const metadata = kind === 'texture' && texCategory ? { category: texCategory } : undefined;
      const row = await uploadUserFile(file, kind, { metadata });
      setUploads((prev) => [row, ...prev]);
      const catNote = kind === 'texture' ? `（${textureCategoryLabel(texCategory)}）` : '';
      setMsg(`「${row.originalName ?? file.name}」${catNote}をアップロードしました。`);
      if (kind === 'texture') onUploadsChanged?.(); // エディタの素材一覧へ即時反映
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'アップロードに失敗しました。');
    } finally {
      setBusyKind(null);
      if (modelInputRef.current) modelInputRef.current.value = '';
      if (textureInputRef.current) textureInputRef.current.value = '';
    }
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
  // 容量警告（管理表 row 31）: 本人のアップロード合計と上限しきい値。接近で警告し、超過する追加はブロックする。
  // しきい値（STORAGE_SOFT_LIMIT_BYTES）は lib/db/uploads.ts と共有し、表示・追加ブロックで同一値を使う。
  const totalBytes = uploads.reduce((sum, u) => sum + (u.bytes ?? 0), 0);
  const usagePct = Math.min(100, Math.round((totalBytes / STORAGE_SOFT_LIMIT_BYTES) * 100));
  const overLimit = totalBytes >= STORAGE_SOFT_LIMIT_BYTES;
  const nearLimit = !overLimit && usagePct >= 80;
  const fmtMB = (b: number) => (b / (1024 * 1024)).toFixed(1);

  return (
    <div className="rounded-lg bg-neutral-900/60 p-3 text-xs text-neutral-200">
      <p className="mb-1 font-semibold text-neutral-300">マイアップロード</p>
      <p className="mb-2 text-[11px] leading-snug text-neutral-500">
        独自の 3D モデル（{ACCEPTED_EXT.model.join(' / ')}）やテクスチャ（
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
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full transition-all ${overLimit ? 'bg-red-500' : nearLimit ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${Math.max(2, usagePct)}%` }}
          />
        </div>
        {(overLimit || nearLimit) && (
          <p className={`mt-1 text-[10px] leading-snug ${overLimit ? 'text-red-300' : 'text-amber-300'}`}>
            {overLimit
              ? '容量の上限に達しました。不要なアップロードを削除してください。'
              : '容量の上限に近づいています。不要なアップロードの削除をご検討ください。'}
          </p>
        )}
      </div>

      {/* テクスチャに割り当てるカテゴリ。「＋テクスチャ」で追加する素材の表示カテゴリを決める
          （壁/床/天井のいずれか、または共通＝全カテゴリに表示）。一覧から後で変更も可能。 */}
      <div className="mb-2">
        <p className="mb-1 text-[11px] text-neutral-400">テクスチャのカテゴリ（追加先）</p>
        <div className="flex gap-1">
          {TEXTURE_CATEGORY_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              disabled={busy}
              onClick={() => setTexCategory(opt.value)}
              className={`flex-1 rounded py-1 text-[11px] font-semibold transition disabled:opacity-50 ${
                texCategory === opt.value
                  ? 'bg-sky-600 text-white'
                  : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex gap-1.5">
        <button
          type="button"
          disabled={busy || overLimit}
          onClick={() => handlePick('model')}
          className="flex-1 rounded bg-emerald-600 py-1.5 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {busyKind === 'model' ? 'アップロード中…' : '＋ 3Dモデル'}
        </button>
        <button
          type="button"
          disabled={busy || overLimit}
          onClick={() => handlePick('texture')}
          className="flex-1 rounded bg-neutral-700 py-1.5 font-semibold text-white transition hover:bg-neutral-600 disabled:opacity-50"
        >
          {busyKind === 'texture' ? 'アップロード中…' : `＋ テクスチャ（${textureCategoryLabel(texCategory)}）`}
        </button>
      </div>

      <input
        ref={modelInputRef}
        type="file"
        accept={ACCEPTED_EXT.model.join(',')}
        className="hidden"
        onChange={(e) => void handleFile('model', e.target.files?.[0])}
      />
      <input
        ref={textureInputRef}
        type="file"
        accept={ACCEPTED_EXT.texture.join(',')}
        className="hidden"
        onChange={(e) => void handleFile('texture', e.target.files?.[0])}
      />

      {msg && <p className="mb-2 text-[11px] text-neutral-400">{msg}</p>}

      {loading && uploads.length === 0 ? (
        <p className="text-[11px] text-neutral-500">読み込み中…</p>
      ) : uploads.length === 0 ? (
        <p className="text-[11px] text-neutral-500">まだアップロードはありません。</p>
      ) : (
        <ul className="space-y-1.5">
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
  );
}
