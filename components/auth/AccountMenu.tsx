import { useState } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';
import {
  getCachedGeminiKeyLast4,
  saveAndCacheGeminiKey,
  clearAndUncacheGeminiKey,
} from '../../lib/byok.js';

/**
 * ログイン中のアカウント表示 + Gemini APIキー（BYOK）の設定 + ログアウト。
 * ※暫定的に画面右上の固定チップとして表示する。状態リファクタ後にアプリのヘッダーへ統合予定。
 */
export function AccountMenu() {
  const { email, signOut, configured } = useAuth();
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [last4, setLast4] = useState<string | null>(getCachedGeminiKeyLast4());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const initial = (email ?? '?').charAt(0).toUpperCase();

  const toggle = () => {
    // 開くたびに最新のキャッシュ状態（設定済み末尾4桁）を反映。
    setLast4(getCachedGeminiKeyLast4());
    setMsg(null);
    setOpen((o) => !o);
  };

  const handleSave = async () => {
    const key = keyInput.trim();
    if (!key) {
      setMsg('APIキーを入力してください。');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await saveAndCacheGeminiKey(key);
      setLast4(getCachedGeminiKeyLast4());
      setKeyInput('');
      setMsg('APIキーを保存しました。');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '保存に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await clearAndUncacheGeminiKey();
      setLast4(null);
      setKeyInput('');
      setMsg('APIキーを削除しました。');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '削除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed right-2 top-2 z-[1000] text-xs">
      <button
        type="button"
        onClick={toggle}
        title={email ?? 'アカウント'}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 font-semibold text-white shadow ring-1 ring-black/20 transition hover:bg-emerald-500"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-lg bg-neutral-800 p-3 text-neutral-200 shadow-xl ring-1 ring-white/10">
          <p className="mb-2 truncate text-[11px] text-neutral-400" title={email ?? ''}>
            {email ?? 'ログイン中'}
          </p>

          {/* BYOK: Gemini APIキー */}
          <div className="mb-3 rounded-md bg-neutral-900/60 p-2">
            <p className="mb-1 font-semibold text-neutral-300">Gemini APIキー</p>
            {configured ? (
              <>
                <p className="mb-1.5 text-[10px] leading-snug text-neutral-500">
                  AI生成にはご自身のキーを使用します。
                  {last4 ? `設定済み（末尾 ${last4}）。` : '未設定です。'}
                </p>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={last4 ? '新しいキーで更新' : 'AIza...'}
                  autoComplete="off"
                  spellCheck={false}
                  className="mb-1.5 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-emerald-500"
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleSave()}
                    className="flex-1 rounded bg-emerald-600 py-1 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                  >
                    保存
                  </button>
                  {last4 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleClear()}
                      className="rounded bg-neutral-700 px-2 py-1 transition hover:bg-neutral-600 disabled:opacity-50"
                    >
                      削除
                    </button>
                  )}
                </div>
                {msg && <p className="mt-1.5 text-[10px] text-neutral-400">{msg}</p>}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 block text-[10px] text-emerald-400 hover:underline"
                >
                  キーを取得 →
                </a>
              </>
            ) : (
              <p className="text-[10px] text-neutral-500">
                ローカルモードでは環境変数のキーを使用します。
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="w-full rounded-md bg-neutral-700/70 py-1.5 text-center transition hover:bg-neutral-700"
          >
            ログアウト
          </button>
        </div>
      )}
    </div>
  );
}
