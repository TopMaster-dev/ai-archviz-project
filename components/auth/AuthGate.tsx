import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { AuthScreen } from './AuthScreen.js';
import { AccountMenu } from './AccountMenu.js';
import { ProjectSaveIndicator } from '../ProjectSaveIndicator.js';

/**
 * 認証ゲート。
 * - Supabase 未構成（ローカル/ゲスト）: ゲートをかけず従来どおりアプリを表示。
 * - 構成済み・未ログイン: ログイン/新規登録画面を表示。
 * - 構成済み・ログイン済み: アプリを表示。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { configured, loading, userId } = useAuth();

  if (!configured) return <>{children}</>;

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 text-neutral-300">
        読み込み中…
      </div>
    );
  }

  if (!userId) return <AuthScreen />;

  return (
    <>
      {children}
      <AccountMenu />
      <ProjectSaveIndicator />
    </>
  );
}
