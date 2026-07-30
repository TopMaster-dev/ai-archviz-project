import React, { useCallback, useRef } from 'react';
import { Calendar } from 'lucide-react';

/**
 * 管理画面の期間指定（260731 クライアント要望③）。
 *
 * 元々 <input type="date"> は使っていたが、Chrome では入力欄の文字部分をクリックしても
 * カレンダーが開かず、右端の小さいアイコンを狙って押す必要がある。
 * 「年/月/日」を手で打つしかない、と受け取られていたのはこのため。
 *
 * ここでは type="date" のまま（＝OS のカレンダー・キーボード入力・ロケール表示をそのまま活かす）、
 * 欄のどこを押してもカレンダーが開くようにする。自前のカレンダーを作らないのは、
 * 日付の妥当性・和暦/西暦・キーボード操作・スクリーンリーダー対応を再実装せずに済むため。
 */

/** showPicker() は Chrome/Edge/Safari16+/Firefox で利用可。未対応環境では従来どおりアイコンから開く。 */
function openPicker(el: HTMLInputElement | null) {
  if (!el) return;
  try {
    (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
  } catch {
    /* ユーザー操作起因でない等で弾かれても、通常の入力は妨げない */
  }
}

export function DateField({
  label,
  value,
  min,
  max,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (next: string) => void;
  testId?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const open = useCallback(() => openPicker(ref.current), []);
  return (
    <label className="text-[11px] text-neutral-400">
      {label}
      <span className="relative mt-0.5 block">
        <input
          ref={ref}
          data-testid={testId}
          type="date"
          value={value}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          // 欄のどこを押してもカレンダーを開く（アイコンを狙わせない）。
          onClick={open}
          onFocus={open}
          className="w-[150px] cursor-pointer rounded-md border border-white/15 bg-black/40 py-1 pl-2 pr-7 text-xs text-white outline-none focus:border-emerald-500/60"
        />
        <Calendar
          className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500"
          aria-hidden
        />
      </span>
    </label>
  );
}

/** ローカル日付を input[type=date] の値（YYYY-MM-DD）へ。toISOString はUTC変換で日付がずれるため使わない。 */
export function toDateInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface PeriodPreset {
  label: string;
  /** [開始日, 終了日] を YYYY-MM-DD で返す。 */
  range: (today: Date) => [string, string];
}

/**
 * よく使う期間（260731）。
 * 請求の確認は「今月」「先月」が大半なので、その2つを1クリックで出せるようにする。
 * 月末日は new Date(y, m+1, 0) で求める（月ごとの日数・うるう年を自前で持たない）。
 */
export const PERIOD_PRESETS: PeriodPreset[] = [
  {
    label: '今月',
    range: (t) => [toDateInputValue(new Date(t.getFullYear(), t.getMonth(), 1)), toDateInputValue(t)],
  },
  {
    label: '先月',
    range: (t) => [
      toDateInputValue(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
      toDateInputValue(new Date(t.getFullYear(), t.getMonth(), 0)),
    ],
  },
  {
    label: '過去7日',
    range: (t) => [toDateInputValue(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6)), toDateInputValue(t)],
  },
  {
    label: '過去30日',
    range: (t) => [toDateInputValue(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29)), toDateInputValue(t)],
  },
];
