import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { AuthScreen } from './AuthScreen.js';
import { RegistrationScreen } from './RegistrationScreen.js';
import { UndoRedoBar } from '../UndoRedoBar.js';
import { ProjectSessionProvider } from '../../lib/project/projectSessionContext.js';
import { AuthedShell } from './AuthedShell.js';

/**
 * 認証ゲート。
 * - Supabase 未構成（ローカル/ゲスト）: ゲートをかけず従来どおりアプリを表示。
 * - 構成済み・未ログイン: ログイン/ランディング画面を表示。
 * - 構成済み・ログイン済み・本登録未完了（招待直後）: 本登録画面を表示（row 38）。
 * - 構成済み・ログイン済み・本登録済み: アプリを表示。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { configured, loading, userId, profile } = useAuth();

  if (!configured) {
    return (
      <>
        {children}
        <UndoRedoBar />
      </>
    );
  }

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 text-neutral-300">
        読み込み中…
      </div>
    );
  }

  if (!userId) return <AuthScreen />;

  // セッションはあるがプロフィール未取得（招待直後の読み込み中を含む）。
  // handle_new_user トリガにより profiles 行は必ず作成されるため、ここは一時的な状態。
  if (!profile) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 text-neutral-300">
        読み込み中…
      </div>
    );
  }

  // 招待で作成された直後は role='pro' の空プロフィールが自動作成されるが本登録は未完了。
  // registered_at が未設定なら本登録（属性入力・規約同意）画面を表示する（管理表 row 38）。
  if (!profile.registered_at) {
    return <RegistrationScreen />;
  }

  // ログイン後はホーム画面（プロジェクト管理）→ エディタ の順。AuthedShell が切替を担う。
  return (
    <ProjectSessionProvider>
      <AuthedShell>{children}</AuthedShell>
    </ProjectSessionProvider>
  );
}
