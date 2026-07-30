import { describe, it, expect } from 'vitest';
import { PERIOD_PRESETS, toDateInputValue } from './DateRangeField.js';

/**
 * 260731 クライアント要望③「期間指定を、カレンダーから直感的に選べるように」。
 *
 * 日付の計算は月末・うるう年・タイムゾーンで壊れやすく、しかも壊れても
 * 「なんとなく合っている日付」が出るため気付きにくい。ここで数値を固定する。
 */
describe('日付の文字列化', () => {
  it('ローカル日付をそのまま返す（UTC変換で1日ずれない）', () => {
    // 日本時間の 09:00 未満は toISOString だと前日になる。ここがずれると集計期間が1日ずれる。
    expect(toDateInputValue(new Date(2026, 6, 1, 0, 30))).toBe('2026-07-01');
    expect(toDateInputValue(new Date(2026, 6, 31, 23, 59))).toBe('2026-07-31');
  });

  it('1桁の月日は0埋めする', () => {
    expect(toDateInputValue(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('よく使う期間', () => {
  const preset = (label: string) => {
    const p = PERIOD_PRESETS.find((x) => x.label === label);
    if (!p) throw new Error(`preset ${label} not found`);
    return p;
  };

  it('今月は1日から今日まで', () => {
    expect(preset('今月').range(new Date(2026, 6, 30))).toEqual(['2026-07-01', '2026-07-30']);
  });

  it('先月は先月1日から先月末まで', () => {
    expect(preset('先月').range(new Date(2026, 6, 30))).toEqual(['2026-06-01', '2026-06-30']);
  });

  it('先月末を月ごとの日数で正しく出す（31日の月）', () => {
    expect(preset('先月').range(new Date(2026, 5, 15))).toEqual(['2026-05-01', '2026-05-31']);
  });

  it('うるう年の2月も正しい', () => {
    expect(preset('先月').range(new Date(2024, 2, 10))).toEqual(['2024-02-01', '2024-02-29']);
  });

  it('年をまたぐ先月（1月→前年12月）', () => {
    expect(preset('先月').range(new Date(2026, 0, 10))).toEqual(['2025-12-01', '2025-12-31']);
  });

  it('過去7日は今日を含めて7日間', () => {
    expect(preset('過去7日').range(new Date(2026, 6, 30))).toEqual(['2026-07-24', '2026-07-30']);
  });

  it('過去30日は今日を含めて30日間（月をまたいでも正しい）', () => {
    expect(preset('過去30日').range(new Date(2026, 6, 10))).toEqual(['2026-06-11', '2026-07-10']);
  });

  it('どの期間も開始日 <= 終了日', () => {
    for (const p of PERIOD_PRESETS) {
      const [f, t] = p.range(new Date(2026, 0, 1));
      expect(f <= t, p.label).toBe(true);
    }
  });
});
