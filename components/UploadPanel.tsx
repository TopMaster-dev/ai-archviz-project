import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth/AuthContext.js';
import {
  ACCEPTED_EXT,
  deleteUserUpload,
  listUserUploads,
  uploadUserFile,
  type UploadKind,
  type UserUpload,
} from '../lib/db/uploads.js';

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

export function UploadPanel() {
  const { configured } = useAuth();
  const [uploads, setUploads] = useState<UserUpload[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKind, setBusyKind] = useState<UploadKind | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
    setBusyKind(kind);
    setMsg(null);
    try {
      const row = await uploadUserFile(file, kind);
      setUploads((prev) => [row, ...prev]);
      setMsg(`「${row.originalName ?? file.name}」をアップロードしました。`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'アップロードに失敗しました。');
    } finally {
      setBusyKind(null);
      if (modelInputRef.current) modelInputRef.current.value = '';
      if (textureInputRef.current) textureInputRef.current.value = '';
    }
  };

  const handleDelete = async (u: UserUpload) => {
    if (!window.confirm(`「${u.originalName ?? 'このファイル'}」を削除しますか？`)) return;
    setDeletingId(u.id);
    setMsg(null);
    try {
      await deleteUserUpload(u);
      setUploads((prev) => prev.filter((x) => x.id !== u.id));
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

  return (
    <div className="rounded-lg bg-neutral-900/60 p-3 text-xs text-neutral-200">
      <p className="mb-1 font-semibold text-neutral-300">マイアップロード</p>
      <p className="mb-2 text-[11px] leading-snug text-neutral-500">
        独自の 3D モデル（{ACCEPTED_EXT.model.join(' / ')}）やテクスチャ（
        {ACCEPTED_EXT.texture.join(' / ')}）を保存できます。
      </p>

      <div className="mb-3 flex gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => handlePick('model')}
          className="flex-1 rounded bg-emerald-600 py-1.5 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {busyKind === 'model' ? 'アップロード中…' : '＋ 3Dモデル'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => handlePick('texture')}
          className="flex-1 rounded bg-neutral-700 py-1.5 font-semibold text-white transition hover:bg-neutral-600 disabled:opacity-50"
        >
          {busyKind === 'texture' ? 'アップロード中…' : '＋ テクスチャ'}
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
