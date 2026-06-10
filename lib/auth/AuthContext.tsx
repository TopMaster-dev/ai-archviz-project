import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getSupabase, isSupabaseConfigured } from '../db/supabaseClient.js';
import { translateAuthError } from './authErrors.js';
import type { Profile, UserRole } from '../db/types.js';
import {
  updateProfile as dbUpdateProfile,
  updateEmail as dbUpdateEmail,
  updatePassword as dbUpdatePassword,
} from '../db/profile.js';

// 認証コンテキスト。属性別サインアップ（プロ/学生/施主、学生は卒業予定年度必須）に対応。
// Supabase 未構成時は configured=false のゲストモードとして動作する。

export interface SignUpParams {
  email: string;
  password: string;
  role: UserRole;
  displayName?: string;
  company?: string;
  graduationYear?: number;
  phone?: string;
}

export interface AuthContextValue {
  /** Supabase 構成済みか（false ならゲストモード=認証不要） */
  configured: boolean;
  loading: boolean;
  userId: string | null;
  email: string | null;
  profile: Profile | null;
  signUp(params: SignUpParams): Promise<{ error: string | null; needsConfirmation: boolean }>;
  signIn(email: string, password: string): Promise<{ error: string | null }>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<{ error: string | null }>;
  refreshProfile(): Promise<void>;
  updateProfile(patch: { display_name?: string | null; phone?: string | null }): Promise<{ error: string | null }>;
  updateEmail(email: string): Promise<{ error: string | null }>;
  updatePassword(password: string): Promise<{ error: string | null }>;
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
    if (!sb) return { error: 'Supabase が未構成です。', needsConfirmation: false };
    if (params.role === 'student' && !params.graduationYear) {
      return { error: '学生の方は卒業予定年度が必須です。', needsConfirmation: false };
    }
    const { data, error } = await sb.auth.signUp({
      email: params.email,
      password: params.password,
      options: {
        // user_metadata（raw_user_meta_data）→ handle_new_user トリガが profiles に展開する。
        data: {
          role: params.role,
          display_name: params.displayName ?? null,
          company: params.company ?? null,
          graduation_year: params.graduationYear ?? null,
          phone: params.phone ?? null,
        },
      },
    });
    if (error) return { error: translateAuthError(error.message), needsConfirmation: false };
    // セッションが返らずユーザーだけ作成された＝メール確認が必要な設定。
    const needsConfirmation = !data.session && !!data.user;
    return { error: null, needsConfirmation };
  }, []);

  const signIn = useCallback(async (em: string, password: string) => {
    const sb = getSupabase();
    if (!sb) return { error: 'Supabase が未構成です。' };
    const { error } = await sb.auth.signInWithPassword({ email: em, password });
    return { error: error ? translateAuthError(error.message) : null };
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
    return { error: error ? translateAuthError(error.message) : null };
  }, []);

  const refreshProfile = useCallback(async () => {
    await loadProfile(userId);
  }, [loadProfile, userId]);

  const updateProfile = useCallback(
    async (patch: { display_name?: string | null; phone?: string | null }) => {
      try {
        await dbUpdateProfile(patch);
        await loadProfile(userId);
        return { error: null };
      } catch (e) {
        return { error: e instanceof Error ? translateAuthError(e.message) : 'プロフィールの更新に失敗しました。' };
      }
    },
    [loadProfile, userId],
  );

  const updateEmail = useCallback(async (em: string) => {
    try {
      await dbUpdateEmail(em);
      return { error: null };
    } catch (e) {
      return { error: e instanceof Error ? translateAuthError(e.message) : 'メールアドレスの変更に失敗しました。' };
    }
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    try {
      await dbUpdatePassword(password);
      return { error: null };
    } catch (e) {
      return { error: e instanceof Error ? translateAuthError(e.message) : 'パスワードの変更に失敗しました。' };
    }
  }, []);

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
      updateProfile,
      updateEmail,
      updatePassword,
    }),
    [configured, loading, userId, email, profile, signUp, signIn, signOut, resetPassword, refreshProfile, updateProfile, updateEmail, updatePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
