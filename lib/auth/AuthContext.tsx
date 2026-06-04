import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getSupabase, isSupabaseConfigured } from '../db/supabaseClient.js';
import type { Profile, UserRole } from '../db/types.js';

// 認証コンテキスト。属性別サインアップ（プロ/学生/施主、学生は卒業予定年度必須）に対応。
// Supabase 未構成時は configured=false のゲストモードとして動作する。

export interface SignUpParams {
  email: string;
  password: string;
  role: UserRole;
  displayName?: string;
  company?: string;
  graduationYear?: number;
}

export interface AuthContextValue {
  /** Supabase 構成済みか（false ならゲストモード=認証不要） */
  configured: boolean;
  loading: boolean;
  userId: string | null;
  email: string | null;
  profile: Profile | null;
  signUp(params: SignUpParams): Promise<{ error: string | null }>;
  signIn(email: string, password: string): Promise<{ error: string | null }>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<{ error: string | null }>;
  refreshProfile(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isSupabaseConfigured();
  const [loading, setLoading] = useState<boolean>(configured);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const loadProfile = useCallback(async (uid: string | null) => {
    const sb = getSupabase();
    if (!sb || !uid) {
      setProfile(null);
      return;
    }
    const { data } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    setProfile((data as Profile | null) ?? null);
  }, []);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) {
      setLoading(false);
      return;
    }
    let active = true;

    void sb.auth.getSession().then(({ data }) => {
      if (!active) return;
      const session = data.session;
      setUserId(session?.user?.id ?? null);
      setEmail(session?.user?.email ?? null);
      void loadProfile(session?.user?.id ?? null);
      setLoading(false);
    });

    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
      setEmail(session?.user?.email ?? null);
      void loadProfile(session?.user?.id ?? null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signUp = useCallback(async (params: SignUpParams) => {
    const sb = getSupabase();
    if (!sb) return { error: 'Supabase が未構成です。' };
    if (params.role === 'student' && !params.graduationYear) {
      return { error: '学生の方は卒業予定年度が必須です。' };
    }
    const { error } = await sb.auth.signUp({
      email: params.email,
      password: params.password,
      options: {
        // user_metadata（raw_user_meta_data）→ handle_new_user トリガが profiles に展開する。
        data: {
          role: params.role,
          display_name: params.displayName ?? null,
          company: params.company ?? null,
          graduation_year: params.graduationYear ?? null,
        },
      },
    });
    return { error: error?.message ?? null };
  }, []);

  const signIn = useCallback(async (em: string, password: string) => {
    const sb = getSupabase();
    if (!sb) return { error: 'Supabase が未構成です。' };
    const { error } = await sb.auth.signInWithPassword({ email: em, password });
    return { error: error?.message ?? null };
  }, []);

  const signOut = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    await sb.auth.signOut();
  }, []);

  const resetPassword = useCallback(async (em: string) => {
    const sb = getSupabase();
    if (!sb) return { error: 'Supabase が未構成です。' };
    const { error } = await sb.auth.resetPasswordForEmail(em);
    return { error: error?.message ?? null };
  }, []);

  const refreshProfile = useCallback(async () => {
    await loadProfile(userId);
  }, [loadProfile, userId]);

  const value = useMemo<AuthContextValue>(
    () => ({
      configured,
      loading,
      userId,
      email,
      profile,
      signUp,
      signIn,
      signOut,
      resetPassword,
      refreshProfile,
    }),
    [configured, loading, userId, email, profile, signUp, signIn, signOut, resetPassword, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
