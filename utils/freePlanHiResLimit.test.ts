import { describe, it, expect, beforeEach } from 'vitest';
import {
  hiResPeriod,
  getHiResDownloadCount,
  incrementHiResDownloadCount,
  isOverHiResLimit,
  hiResRemaining,
  FREE_PLAN_HIRES_DL_PER_MONTH,
} from './freePlanHiResLimit.js';

const U = 'user-1';
const NOW = new Date(2026, 5, 15); // 2026-06

describe('freePlanHiResLimit', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* noop */
    }
  });

  it('hiResPeriod は YYYY-MM（ローカル）', () => {
    expect(hiResPeriod(new Date(2026, 5, 1))).toBe('2026-06');
    expect(hiResPeriod(new Date(2026, 11, 31))).toBe('2026-12');
  });

  it('無料ユーザー: 上限まで無透かし、超過で透かし対象', () => {
    expect(getHiResDownloadCount(U, true, NOW)).toBe(0);
    expect(hiResRemaining(U, true, NOW)).toBe(FREE_PLAN_HIRES_DL_PER_MONTH);
    for (let i = 0; i < FREE_PLAN_HIRES_DL_PER_MONTH; i += 1) {
      expect(isOverHiResLimit(U, true, NOW)).toBe(false); // 1〜3回目は無透かし
      incrementHiResDownloadCount(U, true, NOW);
    }
    expect(getHiResDownloadCount(U, true, NOW)).toBe(FREE_PLAN_HIRES_DL_PER_MONTH);
    expect(hiResRemaining(U, true, NOW)).toBe(0);
    expect(isOverHiResLimit(U, true, NOW)).toBe(true); // 4回目以降は透かし
  });

  it('月替わりでリセット（別キー）', () => {
    for (let i = 0; i < FREE_PLAN_HIRES_DL_PER_MONTH; i += 1) incrementHiResDownloadCount(U, true, NOW);
    const nextMonth = new Date(2026, 6, 1); // 2026-07
    expect(getHiResDownloadCount(U, true, nextMonth)).toBe(0);
    expect(isOverHiResLimit(U, true, nextMonth)).toBe(false);
  });

  it('ゲスト（userId 無し）は無制限', () => {
    for (let i = 0; i < 10; i += 1) incrementHiResDownloadCount(null, true, NOW);
    expect(isOverHiResLimit(null, true, NOW)).toBe(false);
    expect(hiResRemaining(null, true, NOW)).toBe(Infinity);
  });

  it('有料プランは計測しない（無制限）', () => {
    for (let i = 0; i < 10; i += 1) incrementHiResDownloadCount(U, false, NOW);
    expect(isOverHiResLimit(U, false, NOW)).toBe(false);
    expect(getHiResDownloadCount(U, false, NOW)).toBe(0);
    expect(hiResRemaining(U, false, NOW)).toBe(Infinity);
  });
});
