
import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { AuthProvider } from './lib/auth/AuthContext.js';
import { AuthGate } from './components/auth/AuthGate.js';
import { SharedProjectViewer } from './components/share/SharedProjectViewer.js';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// 閲覧用URL（共有・2b）: `?share=<token>` があれば AuthGate を通さず読み取り専用ビューアを描画。
// AuthProvider は残す（ログイン状態に応じて「複製して編集 / ログインして編集」を出し分けるため）。
const shareToken = new URLSearchParams(window.location.search).get('share');

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AuthProvider>
      {shareToken ? (
        <SharedProjectViewer token={shareToken} />
      ) : (
        <AuthGate>
          <App />
        </AuthGate>
      )}
    </AuthProvider>
  </React.StrictMode>
);