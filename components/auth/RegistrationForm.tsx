import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';
import type { UserRole } from '../../lib/db/types.js';
import type { LegalKind } from './LegalPage.js';
import { Field, FormError, FormNotice, inputClass, submitClass } from './formKit.js';

// 招待制の本登録フォーム（管理表 row 38/43/44/46）。
//
// 招待で作成された auth.users には handle_new_user が role='pro' の空プロフィールを
// 自動作成する。本フォームは属性（属性区分・表示名/ニックネーム・連絡先・学生情報）と
// 規約同意を受け取り、profiles を更新して registered_at / terms_accepted_at を確定する。
// 確定後は AuthContext が profile を再読込し、AuthGate が自動でアプリへ遷移する。
//
// 招待メール（パスワード未設定）から初めて利用する場合のために、任意のパスワード設定欄も備える。

const ROLE_LABELS: Record<UserRole, string> = {
  pro: 'プロ（設計・施工）',
  student: '学生',
  owner: '一般',
};

export function RegistrationForm({ onShowLegal }: { onShowLegal?: (kind: LegalKind) => void }) {
  const { profile, updateProfile, updatePassword } = useAuth();

  // 既存プロフィール（招待直後の空行・前回入力途中）から初期値を復元する。
  const [role, setRole] = useState<UserRole>(profile?.role ?? 'pro');
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [company, setCompany] = useState(profile?.company ?? '');
  const [department, setDepartment] = useState(profile?.department ?? '');
  const [schoolYear, setSchoolYear] = useState(profile?.school_year ?? '');
  const [graduationYear, setGraduationYear] = useState(
    profile?.graduation_year != null ? String(profile.graduation_year) : '',
  );
  const [agreed, setAgreed] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isStudent = role === 'student';
  const isOwner = role === 'owner';
  const nameLabel = isOwner ? 'ニックネーム（表示名・必須）' : 'お名前・表示名（必須）';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!displayName.trim()) {
      setError(isOwner ? 'ニックネームを入力してください。' : 'お名前・表示名を入力してください。');
      return;
    }
    const gradYearNum = Number(graduationYear);
    if (isStudent) {
      if (!company.trim()) return setError('学校名を入力してください。');
      if (!department.trim()) return setError('学部を入力してください。');
      if (!schoolYear.trim()) return setError('学年を入力してください。');
      if (!graduationYear.trim() || !Number.isFinite(gradYearNum)) {
        return setError('卒業予定年度を入力してください。');
      }
    }
    if (!agreed) {
      setError('利用規約・プライバシーポリシーへの同意が必要です。');
      return;
    }
    if (password) {
      if (password.length < 8) return setError('パスワードは8文字以上で設定してください。');
      if (password !== passwordConfirm) return setError('パスワード（確認）が一致しません。');
    }

    setBusy(true);
    // 招待メールから初回利用（パスワード未設定）の方が任意で設定したパスワードを先に反映する。
    if (password) {
      const { error: pwErr } = await updatePassword(password);
      if (pwErr) {
        setBusy(false);
        setError(pwErr);
        return;
      }
    }

    const now = new Date().toISOString();
    const { error: upErr } = await updateProfile({
      role,
      display_name: displayName.trim(),
      phone: phone.trim() || null,
      company: isOwner ? null : company.trim() || null,
      graduation_year: isStudent ? gradYearNum : null,
      department: isStudent ? department.trim() || null : null,
      school_year: isStudent ? schoolYear.trim() || null : null,
      registered_at: now,
      terms_accepted_at: now,
    });
    setBusy(false);
    if (upErr) {
      setError(upErr);
      return;
    }
    // 成功。AuthContext が profile を再読込し、AuthGate がアプリ本体へ自動遷移する。
    setNotice('本登録が完了しました。アプリを読み込んでいます…');
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

      <Field label={nameLabel}>
        <input
          type="text"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={isOwner ? '例: にっくねーむ' : '例: 山田 太郎'}
          className={inputClass}
        />
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

      {!isOwner && (
        <Field label={isStudent ? '学校名（必須）' : '会社名（任意）'}>
          <input
            type="text"
            required={isStudent}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className={inputClass}
          />
        </Field>
      )}

      {isStudent && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="学部（必須）">
            <input
              type="text"
              required
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="例: 建築学科"
              className={inputClass}
            />
          </Field>
          <Field label="学年（必須）">
            <input
              type="text"
              required
              value={schoolYear}
              onChange={(e) => setSchoolYear(e.target.value)}
              placeholder="例: 3年"
              className={inputClass}
            />
          </Field>
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
        </div>
      )}

      {/* 任意のパスワード設定（招待メールから初回利用の方向け） */}
      <div className="space-y-3 rounded-lg border border-white/10 bg-neutral-900/40 p-3">
        <p className="text-[11px] leading-relaxed text-neutral-400">
          招待メールから初めてご利用の方は、次回以降のログイン用にパスワードを設定してください（任意）。
          すでにパスワードをお持ちの方は空欄のままで構いません。
        </p>
        <Field label="パスワード（任意・8文字以上）">
          <input
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </Field>
        {password && (
          <Field label="パスワード（確認）">
            <input
              type="password"
              autoComplete="new-password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              className={inputClass}
            />
          </Field>
        )}
      </div>

      {/* 規約・ポリシーへの同意（必須・row 43） */}
      <label className="flex items-start gap-2.5 rounded-lg border border-white/10 bg-neutral-900/40 p-3">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600"
        />
        <span className="text-xs leading-relaxed text-neutral-300">
          <button
            type="button"
            onClick={() => onShowLegal?.('terms')}
            className="text-emerald-400 underline-offset-2 hover:underline"
          >
            利用規約
          </button>
          ・
          <button
            type="button"
            onClick={() => onShowLegal?.('privacy')}
            className="text-emerald-400 underline-offset-2 hover:underline"
          >
            プライバシーポリシー
          </button>
          に同意します。
        </span>
      </label>

      <button type="submit" disabled={busy} className={submitClass}>
        {busy ? '登録中…' : '本登録を完了する'}
      </button>
    </form>
  );
}
