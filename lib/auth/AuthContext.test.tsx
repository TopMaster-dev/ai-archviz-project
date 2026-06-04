import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// Supabase クライアントをモック（configured=true、auth メソッドは spy）。
// vi.hoisted で生成し、vi.mock ファクトリ（ホイストされる）から安全に参照する。
const { signUp, getSession, onAuthStateChange } = vi.hoisted(() => ({
  signUp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));

vi.mock('../db/supabaseClient.js', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({
    auth: {
      getSession,
      onAuthStateChange,
      signUp,
      signInWithPassword: vi.fn(() => Promise.resolve({ error: null })),
      signOut: vi.fn(() => Promise.resolve()),
      resetPasswordForEmail: vi.fn(() => Promise.resolve({ error: null })),
      getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'u1' } } })),
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
    }),
  }),
}));

import { AuthProvider, useAuth } from './AuthContext.js';

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;

describe('AuthProvider — attribute-based signup', () => {
  beforeEach(() => signUp.mockClear());

  it('rejects a student signup that has no graduation year', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const res = await result.current.signUp({ email: 'a@b.com', password: 'password1', role: 'student' });

    expect(res.error).toMatch(/卒業予定年度/);
    expect(signUp).not.toHaveBeenCalled();
  });

  it('forwards attribute metadata to supabase for a pro signup', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const res = await result.current.signUp({
      email: 'pro@b.com',
      password: 'password1',
      role: 'pro',
      company: 'Acme',
    });

    expect(res.error).toBeNull();
    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'pro@b.com',
        options: expect.objectContaining({
          data: expect.objectContaining({ role: 'pro', company: 'Acme' }),
        }),
      }),
    );
  });

  it('accepts a student signup with a graduation year', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const res = await result.current.signUp({
      email: 'stu@b.com',
      password: 'password1',
      role: 'student',
      graduationYear: 2028,
    });

    expect(res.error).toBeNull();
    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          data: expect.objectContaining({ role: 'student', graduation_year: 2028 }),
        }),
      }),
    );
  });
});
