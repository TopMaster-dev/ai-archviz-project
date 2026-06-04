import type { ReactNode } from 'react';

// 認証フォーム共通の小物（重複を避け、見た目を統一）。

export const inputClass =
  'w-full rounded-lg border border-white/10 bg-neutral-900/60 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-500';

export const submitClass =
  'w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-300">{label}</span>
      {children}
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="rounded bg-red-500/10 px-3 py-2 text-sm text-red-400">{message}</p>;
}

export function FormNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="rounded bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">{message}</p>;
}
