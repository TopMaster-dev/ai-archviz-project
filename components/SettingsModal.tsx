import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth/AuthContext.js';
import { ByokKeyPanel } from './ByokKeyPanel.js';

/**
 * 設定モーダル（2c-iv）。ホーム画面の歯車アイコンから開く。
 * プロフィール（氏名・電話番号）／メールアドレス／パスワードの変更と、
 * Gemini APIキーを一箇所に集約する。
 */

const fieldClass =
  'mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-emerald-500';
const primaryBtn =
  'rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { configured, email, profile, updateProfile, updateEmail, updatePassword } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [newEmail, setNewEmail] = useState(email ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // プロフィール/メールがロード・更新されたら入力初期値を同期。
  useEffect(() => {
    setDisplayName(profile?.display_name ?? '');
    setPhone(profile?.phone ?? '');
  }, [profile]);
  useEffect(() => {
    setNewEmail(email ?? '');
  }, [email]);

  const run = async (fn: () => Promise<{ error: string | null }>, ok: string, after?: () => void) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    const { error } = await fn();
    setBusy(false);
    if (error) setErr(error);
    else {
      setMsg(ok);
      after?.();
    }
  };

  const saveProfile = () =>
    run(() => updateProfile({ display_name: displayName.trim() || null, phone: phone.trim() || null }), 'プロフィールを保存しました。');

  const saveEmail = () => {
    const e = newEmail.trim();
    if (!e || e === email) {
      setErr('新しいメールアドレスを入力してください。');
      return;
    }
    void run(() => updateEmail(e), '確認メールを送信しました。新しいアドレスのリンクをクリックすると変更が反映されます。');
  };

  const savePassword = () => {
    if (newPassword.length < 8) {
      setErr('パスワードは8文字以上で入力してください。');
      return;
    }
    void run(() => updatePassword(newPassword), 'パスワードを変更しました。', () => setNewPassword(''));
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900 p-5 text-neutral-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold">設定</h3>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-neutral-400 hover:bg-white/10">
            閉じる
          </button>
        </div>

        {!configured ? (
          <p className="text-xs text-neutral-500">ローカルモードではアカウント設定は利用できません（Supabase 構成時に有効）。</p>
        ) : (
          <div className="space-y-5">
            {(msg || err) && <p className={`text-xs ${err ? 'text-red-300' : 'text-emerald-300'}`}>{err ?? msg}</p>}

            <section className="space-y-2">
              <h4 className="text-xs font-black uppercase tracking-wider text-emerald-300">プロフィール</h4>
              <label className="block text-[11px] text-neutral-400">
                お名前・表示名
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={fieldClass} />
              </label>
              <label className="block text-[11px] text-neutral-400">
                電話番号
                <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="例: 090-1234-5678" className={fieldClass} />
              </label>
              <button type="button" disabled={busy} onClick={() => void saveProfile()} className={primaryBtn}>
                プロフィールを保存
              </button>
            </section>

            <section className="space-y-2 border-t border-white/10 pt-4">
              <h4 className="text-xs font-black uppercase tracking-wider text-emerald-300">メールアドレス</h4>
              <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoComplete="email" className={fieldClass} />
              <button type="button" disabled={busy} onClick={saveEmail} className={primaryBtn}>
                メールを変更
              </button>
              <p className="text-[10px] text-neutral-500">変更後、新しいアドレスに届く確認リンクをクリックすると反映されます。</p>
            </section>

            <section className="space-y-2 border-t border-white/10 pt-4">
              <h4 className="text-xs font-black uppercase tracking-wider text-emerald-300">パスワード変更</h4>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="新しいパスワード（8文字以上）"
                className={fieldClass}
              />
              <button type="button" disabled={busy} onClick={savePassword} className={primaryBtn}>
                パスワードを変更
              </button>
            </section>

            <section className="border-t border-white/10 pt-4">
              <h4 className="mb-2 text-xs font-black uppercase tracking-wider text-emerald-300">APIキー</h4>
              <ByokKeyPanel />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
