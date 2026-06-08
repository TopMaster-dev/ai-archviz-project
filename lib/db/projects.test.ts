import { describe, it, expect } from 'vitest';
import { FREE_PLAN_PROJECT_LIMIT, isFreePlanLimitError } from './projects.js';

describe('free plan limit helpers', () => {
  it('mirrors the DB free_plan_project_limit() value (5)', () => {
    expect(FREE_PLAN_PROJECT_LIMIT).toBe(5);
  });

  it('detects the Postgres trigger rejection (PostgrestError-like object)', () => {
    const err = {
      message: 'FREE_PLAN_LIMIT_REACHED: 保存上限(5件)に達しています',
      code: '23514',
    };
    expect(isFreePlanLimitError(err)).toBe(true);
  });

  it('detects it from an Error instance and from a raw string', () => {
    expect(isFreePlanLimitError(new Error('FREE_PLAN_LIMIT_REACHED: ...'))).toBe(true);
    expect(isFreePlanLimitError('FREE_PLAN_LIMIT_REACHED')).toBe(true);
  });

  it('ignores unrelated or empty errors', () => {
    expect(isFreePlanLimitError(new Error('network failed'))).toBe(false);
    expect(isFreePlanLimitError({ message: 'duplicate key value' })).toBe(false);
    expect(isFreePlanLimitError(null)).toBe(false);
    expect(isFreePlanLimitError(undefined)).toBe(false);
    expect(isFreePlanLimitError({})).toBe(false);
  });
});
