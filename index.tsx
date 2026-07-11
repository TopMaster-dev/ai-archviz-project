
import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { AuthProvider } from './lib/auth/AuthContext.js';
import { AuthGate } from './components/auth/AuthGate.js';
import { SharedProjectViewer } from './components/share/SharedProjectViewer.js';
import { AdminDashboard } from './components/admin/AdminDashboard.js';
import { ConfirmProvider } from './components/ConfirmDialog.js';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// 閲覧用URL（共有・2b）: `?share=<token>` があれば AuthGate を通さず読み取り専用ビューアを描画。
// AuthProvider は残す（ログイン状態に応じて「複製して編集 / ログインして編集」を出し分けるため）。
const shareToken = new URLSearchParams(window.location.search).get('share');
// 運営ダッシュボード（260711）: `?admin` があれば AuthGate（ログイン必須）の内側で AdminDashboard を描画。
// 実際の管理者判定はサーバー側（ADMIN_EMAILS 許可リスト）で行い、非管理者にはアクセス権なしを表示する。
const adminView = new URLSearchParams(window.location.search).has('admin');

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AuthProvider>
      <ConfirmProvider>
        {shareToken ? (
          <SharedProjectViewer token={shareToken} />
        ) : (
          <AuthGate>{adminView ? <AdminDashboard /> : <App />}</AuthGate>
        )}
      </ConfirmProvider>
    </AuthProvider>
  </React.StrictMode>
);