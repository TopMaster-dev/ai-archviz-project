import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { Field, FormError, FormNotice, inputClass, submitClass } from './formKit.js';

export function LoginForm() {
  const { signIn, resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) setError(error);
  }

  async function onReset() {
    if (!email) {
      setError('再設定用にメールアドレスを入力してください。');
      return;
    }
    const { error } = await resetPassword(email);
    if (error) setError(error);
    else setNotice('パスワード再設定メールを送信しました。');
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormError message={error} />
      <FormNotice message={notice} />
      <Field label="メールアドレス">
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="パスワード">
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </Field>
      <button type="submit" disabled={busy} className={submitClass}>
        {busy ? '...' : 'ログイン'}
      </button>
      <button
        type="button"
        onClick={onReset}
        className="w-full text-center text-xs text-neutral-400 transition hover:text-neutral-200"
      >
        パスワードをお忘れですか？
      </button>
    </form>
  );
}
