import { useState } from 'react';
import type { FormEvent } from 'react';
import { submitRegistrationRequest } from '../../lib/db/loginLog.js';
import { Field, FormError, inputClass, submitClass } from './formKit.js';

/**
 * 登録リクエストフォーム（#2 再設計・260716）。
 * 招待制を維持したまま、利用希望者は「メールアドレスのみ」を入力して登録をリクエストする。
 * 送信時にサーバ側で「同一PC or 同一メール」の重複を判定し、重複ならブロックする。
 * 運営が承認すると、そのメール宛に招待リンクが送られ、リンクから本登録（第2画面）に進む。
 */
export function RegistrationRequestForm({ onGoToLogin }: { onGoToLogin?: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'sent' | 'blocked'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await submitRegistrationRequest(email.trim(), name.trim());
    setBusy(false);
    if (r.blocked) {
      setState('blocked');
      return;
    }
    if (r.ok) {
      setState('sent');
      return;
    }
    setError(
      r.reason === 'invalid-email'
        ? 'メールアドレスの形式が正しくありません。'
        : '送信に失敗しました。時間をおいて再度お試しください。',
    );
  }

  if (state === 'sent') {
    return (
      <div className="space-y-4 text-center">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-xs leading-relaxed text-emerald-200">
          登録リクエストを受け付けました。
          <br />
          運営の承認後、ご入力のメールアドレスに招待リンクをお送りします。
        </div>
        <button type="button" onClick={() => onGoToLogin?.()} className={submitClass}>
          ログインへ
        </button>
      </div>
    );
  }

  if (state === 'blocked') {
    return (
      <div className="space-y-4 text-center">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs leading-relaxed text-amber-200">
          このPC、またはこのメールアドレスは既に登録・申請済みです。
          <br />
          既存のアカウントでログインしてください。
        </div>
        <button type="button" onClick={() => onGoToLogin?.()} className={submitClass}>
          ログインへ
        </button>
        <button
          type="button"
          onClick={() => setState('idle')}
          className="block w-full text-center text-[11px] text-neutral-500 transition hover:text-neutral-300"
        >
          ← 入力に戻る
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormError message={error} />
      <p className="text-[12px] leading-relaxed text-neutral-400">
        ご利用には運営の承認が必要です。お名前とメールアドレスを入力して登録をリクエストしてください。
        承認後、ご入力のメールアドレスに招待リンクをお送りします。
      </p>
      <Field label="お名前">
        <input
          type="text"
          required
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </Field>
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
      <button type="submit" disabled={busy || !email.trim() || !name.trim()} className={submitClass}>
        {busy ? '送信中…' : '登録をリクエスト'}
      </button>
    </form>
  );
}
