import { describe, it, expect } from 'vitest';
import { deriveCreditStatus, creditBlockMessage, ENABLE_FREE_PLAN_AI_CREDITS } from './freePlanCredits.js';

const NOW = Date.parse('2026-06-17T00:00:00Z');
const FUTURE = '2026-09-17T00:00:00Z';
const PAST = '2026-03-17T00:00:00Z';

describe('deriveCreditStatus', () => {
  it('computes remaining = max(0, total - used)', () => {
    expect(deriveCreditStatus({ isFreePlan: true, total: 50, used: 3, expiresAt: FUTURE, now: NOW }).remaining).toBe(47);
    expect(deriveCreditStatus({ isFreePlan: true, total: 50, used: 50, expiresAt: FUTURE, now: NOW }).remaining).toBe(0);
    // 過消費でも負にならない
    expect(deriveCreditStatus({ isFreePlan: true, total: 50, used: 60, expiresAt: FUTURE, now: NOW }).remaining).toBe(0);
  });

  it('treats null/undefined counts as 0', () => {
    const s = deriveCreditStatus({ isFreePlan: true, total: null, used: undefined, expiresAt: null, now: NOW });
    expect(s.total).toBe(0);
    expect(s.used).toBe(0);
    expect(s.remaining).toBe(0);
  });

  it('flags expiry by comparing expiresAt to now', () => {
    expect(deriveCreditStatus({ isFreePlan: true, total: 50, used: 0, expiresAt: PAST, now: NOW }).expired).toBe(true);
    expect(deriveCreditStatus({ isFreePlan: true, total: 50, used: 0, expiresAt: FUTURE, now: NOW }).expired).toBe(false);
    // 失効日なしは失効しない
    expect(deriveCreditStatus({ isFreePlan: true, total: 50, used: 0, expiresAt: null, now: NOW }).expired).toBe(false);
  });

  it('active follows the flag AND free plan; paid is never active', () => {
    const free = deriveCreditStatus({ isFreePlan: true, total: 50, used: 0, expiresAt: FUTURE, now: NOW });
    const paid = deriveCreditStatus({ isFreePlan: false, total: 0, used: 0, expiresAt: null, now: NOW });
    expect(free.active).toBe(ENABLE_FREE_PLAN_AI_CREDITS); // テストマーケ中（false）は非活性
    expect(paid.active).toBe(false); // 有料は常に非活性
    // 非活性なら残0/失効でも blocked にならない（生成を止めない）
    if (!ENABLE_FREE_PLAN_AI_CREDITS) {
      expect(deriveCreditStatus({ isFreePlan: true, total: 1, used: 1, expiresAt: PAST, now: NOW }).blocked).toBe(false);
    }
  });

  it('creditBlockMessage is null unless blocked, and tolerates null/undefined', () => {
    expect(creditBlockMessage(null)).toBeNull();
    expect(creditBlockMessage(undefined)).toBeNull();
    expect(
      creditBlockMessage(deriveCreditStatus({ isFreePlan: true, total: 50, used: 0, expiresAt: FUTURE, now: NOW })),
    ).toBeNull();
  });
});
