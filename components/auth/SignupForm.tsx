import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';
import type { UserRole } from '../../lib/db/types.js';
import { checkDeviceForReregistration } from '../../lib/db/loginLog.js';
import { Field, FormError, FormNotice, inputClass, submitClass } from './formKit.js';

const ROLE_LABELS: Record<UserRole, string> = {
  pro: 'プロ（設計・施工）',
  student: '学生',
  owner: '一般',
};

export function SignupForm({ onRegistered, onGoToLogin }: { onRegistered?: () => void; onGoToLogin?: () => void }) {
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('pro');
  const [displayName, setDisplayName] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [graduationYear, setGraduationYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // #2（260715）: 同一PCで既に登録済みの場合のブロック表示。
  const [deviceBlocked, setDeviceBlocked] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    // #2: 登録前に「このPCで既に別アカウントが登録済みか」を確認（サーバ側フラグ OFF 時は常に許可）。
    const deviceCheck = await checkDeviceForReregistration();
    if (deviceCheck.blocked) {
      setDeviceBlocked(true);
      setBusy(false);
      return;
    }
    const { error, needsConfirmation } = await signUp({
      email,
      password,
      role,
      displayName: displayName || undefined,
      company: company || undefined,
      phone: phone || undefined,
      graduationYear: role === 'student' ? Number(graduationYear) || undefined : undefined,
    });
    setBusy(false);
    if (error) {
      setError(error);
      return;
    }
    if (needsConfirmation) {
      // メール確認が有効な設定。確認後にログインが必要。
      setNotice('確認メールを送信しました。メール内のリンクで登録を完了し、ログインしてください。');
      onRegistered?.();
    } else {
      // セッション作成済み（メール確認オフ）。認証ゲートが自動でアプリへ遷移する。
      setNotice('登録が完了しました。アプリを読み込んでいます…');
    }
  }

  if (deviceBlocked) {
    return (
      <div className="space-y-4 text-center">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-relaxed text-amber-200">
          このPCは、別のメールアドレスで既に登録されています。
          <br />
          お手数ですが、既存のアカウントでログインしてください。
        </div>
        <button type="button" onClick={() => onGoToLogin?.()} className={submitClass}>
          ログインへ
        </button>
        <button
          type="button"
          onClick={() => setDeviceBlocked(false)}
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
      <FormNotice message={notice} />

      <Field label="ご利用属性">
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(ROLE_LABELS) as UserRole[]).map((r) => (
            <button
              type="button"
              key={r}
              onClick={() => setRole(r)}
              className={`rounded-lg py-2 text-xs transition ${
                role === r ? 'bg-emerald-600 text-white' : 'bg-neutral-700/50 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {ROLE_LABELS[r]}
            </button>
          ))}
        </div>
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

      <Field label="パスワード（8文字以上）">
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label="お名前・表示名（任意）">
        <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
      </Field>

      <Field label="電話番号（任意）">
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="例: 090-1234-5678"
          className={inputClass}
        />
      </Field>

      {role !== 'owner' && (
        <Field label={role === 'student' ? '学校名（任意）' : '会社名（任意）'}>
          <input type="text" value={company} onChange={(e) => setCompany(e.target.value)} className={inputClass} />
        </Field>
      )}

      {role === 'student' && (
        <Field label="卒業予定年度（必須）">
          <input
            type="number"
            required
            min={2024}
            max={2100}
            value={graduationYear}
            onChange={(e) => setGraduationYear(e.target.value)}
            placeholder="例: 2028"
            className={inputClass}
          />
        </Field>
      )}

      <button type="submit" disabled={busy} className={submitClass}>
        {busy ? '...' : '新規登録'}
      </button>
    </form>
  );
}
