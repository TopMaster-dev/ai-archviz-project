import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { AuthScreen } from './AuthScreen.js';
import { RegistrationScreen } from './RegistrationScreen.js';
import { ProfileLoadingScreen } from './ProfileLoadingScreen.js';
import { LockedScreen } from './LockedScreen.js';
import { UndoRedoBar } from '../UndoRedoBar.js';
import { ProjectSessionProvider } from '../../lib/project/projectSessionContext.js';
import { AuthedShell } from './AuthedShell.js';

/**
 * 認証ゲート。
 * - Supabase 未構成（ローカル/ゲスト）: ゲートをかけず従来どおりアプリを表示。
 * - 構成済み・未ログイン: ログイン/ランディング画面を表示。
 * - 構成済み・ログイン済み・本登録未完了（招待直後）: 本登録画面を表示（row 38）。
 * - 構成済み・ログイン済み・本登録済み: アプリを表示。
 *
 * bare=true: 認証チェック（ログイン必須・本登録・ロック）はそのまま通すが、通常アプリの
 *   プロジェクト・シェル（ProjectSessionProvider + AuthedShell）を挟まず children を直接描画する。
 *   運営ダッシュボード（?admin）のような全画面ビュー用。AuthedShell は「プロジェクトを開くまで
 *   ホーム画面を表示し children を無視する」ため、そこへ管理画面を入れると永久に表示されない（260713 修正）。
 */
export function AuthGate({ children, bare = false }: { children: ReactNode; bare?: boolean }) {
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
  // 通常は handle_new_user トリガが profiles 行を必ず作成するため一時的な状態だが、
  // スキーマ未適用などで解消しない場合に備え、一定時間後に再読み込み/ログアウトを提示する。
  if (!profile) {
    return <ProfileLoadingScreen />;
  }

  // 自動/管理ロック（row 54）。locked_at が設定されたアカウントはアプリ利用を停止する。
  // 自動ロックの検知は ENABLE_AUTO_ACCOUNT_LOCK 有効時のみ作動するため、無効（既定）なら locked_at は付かず無害。
  if (profile.locked_at) {
    return <LockedScreen />;
  }

  // 招待で作成された直後は role='pro' の空プロフィールが自動作成されるが本登録は未完了。
  // registered_at が未設定なら本登録（属性入力・規約同意）画面を表示する（管理表 row 38）。
  if (!profile.registered_at) {
    return <RegistrationScreen />;
  }

  // 全画面ビュー（運営ダッシュボード等）は、プロジェクト・シェルを挟まず直接描画する。
  // AuthedShell はプロジェクトを開くまでホーム画面を出し children を無視するため、ここを通すと表示されない。
  if (bare) {
    return <>{children}</>;
  }

  // ログイン後はホーム画面（プロジェクト管理）→ エディタ の順。AuthedShell が切替を担う。
  return (
    <ProjectSessionProvider>
      <AuthedShell>{children}</AuthedShell>
    </ProjectSessionProvider>
  );
}
