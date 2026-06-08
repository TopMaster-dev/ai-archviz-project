import { describe, it, expect } from 'vitest';
import { translateAuthError } from './authErrors.js';

describe('translateAuthError', () => {
  it('maps known Supabase auth errors to Japanese guidance', () => {
    expect(translateAuthError('Invalid login credentials')).toContain('正しくありません');
    expect(translateAuthError('Email not confirmed')).toContain('未確認');
    expect(translateAuthError('User already registered')).toContain('既に登録');
    expect(translateAuthError('Password should be at least 8 characters')).toContain('8文字以上');
    expect(translateAuthError('Unable to validate email address')).toContain('形式');
    expect(translateAuthError('Email rate limit exceeded')).toContain('しばらく');
  });

  it('is case-insensitive', () => {
    expect(translateAuthError('INVALID LOGIN CREDENTIALS')).toContain('正しくありません');
  });

  it('passes unknown messages through unchanged (no information loss)', () => {
    expect(translateAuthError('some unexpected backend error')).toBe('some unexpected backend error');
  });
});
