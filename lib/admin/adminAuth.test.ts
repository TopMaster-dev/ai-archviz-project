import { describe, it, expect } from 'vitest';
import { parseAdminEmails, isAdminEmail } from './adminAuth.js';

describe('parseAdminEmails', () => {
  it('カンマ区切りを小文字・トリムして配列化', () => {
    expect(parseAdminEmails(' A@x.com , b@Y.com ,, c@z.com ')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });
  it('未設定/空は空配列（deny-all）', () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails('')).toEqual([]);
    expect(parseAdminEmails(null)).toEqual([]);
  });
});

describe('isAdminEmail', () => {
  const list = parseAdminEmails('admin@x.com, ops@y.com');
  it('許可リストのメールは true（大文字小文字・空白無視）', () => {
    expect(isAdminEmail('admin@x.com', list)).toBe(true);
    expect(isAdminEmail('  ADMIN@X.com ', list)).toBe(true);
    expect(isAdminEmail('ops@y.com', list)).toBe(true);
  });
  it('リスト外・空・空リストは false', () => {
    expect(isAdminEmail('user@x.com', list)).toBe(false);
    expect(isAdminEmail('', list)).toBe(false);
    expect(isAdminEmail(null, list)).toBe(false);
    expect(isAdminEmail('admin@x.com', [])).toBe(false);
  });
});
