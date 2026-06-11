import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth/AuthContext.js';
import {
  getCachedGeminiKeyLast4,
  saveAndCacheGeminiKey,
  clearAndUncacheGeminiKey,
  refreshGeminiKey,
} from '../lib/byok.js';

/**
 * BYOK（各ユーザーの Gemini API キー）設定パネル。ホーム画面とアカウントメニューで共用。
 * キー本体は表示せず、末尾4桁のみ表示する。
 */
export function ByokKeyPanel() {
  const { configured } = useAuth();
  const [keyInput, setKeyInput] = useState('');
  const [last4, setLast4] = useState<string | null>(getCachedGeminiKeyLast4());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // ログイン直後はキャッシュ反映が非同期のことがあるため、保存済みキーを読み込んで末尾4桁を更新。
  useEffect(() => {
    let alive = true;
    void refreshGeminiKey().then(() => {
      if (alive) setLast4(getCachedGeminiKeyLast4());
    });
    return () => {
      alive = false;
    };
  }, []);

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
    <div className="rounded-lg bg-neutral-900/60 p-3 text-xs text-neutral-200">
      <p className="mb-1 font-semibold text-neutral-300">Gemini APIキー</p>
      {configured ? (
        <>
          <p className="mb-2 text-[11px] leading-snug text-neutral-500">
            AI生成にはご自身のキーを使用します。
            {last4
              ? `設定済み（末尾 ${last4}）。`
              : '未設定です。テスト期間中は、キー未設定でも共有のキーでAI機能をご利用いただけます。'}
          </p>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={last4 ? '新しいキーで更新' : 'AIza... または AQ....'}
            autoComplete="off"
            spellCheck={false}
            className="mb-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100 outline-none focus:border-emerald-500"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSave()}
              className="flex-1 rounded bg-emerald-600 py-1.5 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              保存
            </button>
            {last4 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleClear()}
                className="rounded bg-neutral-700 px-3 py-1.5 transition hover:bg-neutral-600 disabled:opacity-50"
              >
                削除
              </button>
            )}
          </div>
          {msg && <p className="mt-2 text-[11px] text-neutral-400">{msg}</p>}
          <a
            href="https://aistudio.google.com/app/apikey"
            target="_blank"
            rel="noreferrer"
            className="mt-2 block text-[11px] text-emerald-400 hover:underline"
          >
            キーを取得 →
          </a>
        </>
      ) : (
        <p className="text-[11px] text-neutral-500">ローカルモードでは環境変数のキーを使用します。</p>
      )}
    </div>
  );
}
