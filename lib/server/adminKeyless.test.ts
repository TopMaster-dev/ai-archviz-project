import { describe, it, expect, afterEach } from 'vitest';
import { testKey } from './adminDashboard.js';
import { getInfraStatus } from './adminInfra.js';

/**
 * 「資格情報が未設定でも安全に configured:false を返し、外部呼び出しも throw もしない」契約を固定する（260712）。
 * これらは実キーが要る本体挙動は実機確認だが、キーレス安全（未設定時の分岐）は自動で守れる。
 */

const KEYS = [
  'GEMINI_API_KEY',
  'REPLICATE_API_TOKEN',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'SUPABASE_URL',
  'VITE_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VERCEL_TOKEN',
  'VERCEL_PROJECT_ID',
];

describe('管理ダッシュボード: キーレス安全（未設定時の分岐・外部呼び出しなし）', () => {
  const saved: Record<string, string | undefined> = {};
  const clearAll = () => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  };
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('testKey: キー未設定なら configured:false（実呼び出ししない）', async () => {
    clearAll();
    const g = await testKey('gemini');
    expect(g).toMatchObject({ engine: 'gemini', configured: false, valid: false });
    const r = await testKey('replicate');
    expect(r).toMatchObject({ engine: 'replicate', configured: false, valid: false });
  });

  it('getInfraStatus: 資格情報未設定でも throw せず、全プロバイダ configured:false＋リンクを返す', async () => {
    clearAll();
    const s = await getInfraStatus();
    expect(s.cloudinary.configured).toBe(false);
    expect(s.supabase.configured).toBe(false);
    expect(s.vercel.configured).toBe(false);
    for (const p of [s.cloudinary, s.supabase, s.vercel]) {
      expect(typeof p.link).toBe('string');
      expect(p.link.length).toBeGreaterThan(0);
    }
  });
});
