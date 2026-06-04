import { useState } from 'react';
import { LoginForm } from './LoginForm.js';
import { SignupForm } from './SignupForm.js';

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');

  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-neutral-900 px-4">
      <div className="w-full max-w-md rounded-2xl bg-neutral-800/80 p-8 shadow-xl ring-1 ring-white/10">
        <h1 className="mb-1 text-center text-2xl font-bold text-white">Arise</h1>
        <p className="mb-6 text-center text-sm text-neutral-400">建築・内装向け AI 空間デザイン</p>

        <div className="mb-6 flex rounded-lg bg-neutral-700/50 p-1 text-sm">
          <button
            type="button"
            onClick={() => setMode('login')}
            className={`flex-1 rounded-md py-2 transition ${
              mode === 'login' ? 'bg-emerald-600 text-white' : 'text-neutral-300'
            }`}
          >
            ログイン
          </button>
          <button
            type="button"
            onClick={() => setMode('signup')}
            className={`flex-1 rounded-md py-2 transition ${
              mode === 'signup' ? 'bg-emerald-600 text-white' : 'text-neutral-300'
            }`}
          >
            新規登録
          </button>
        </div>

        {mode === 'login' ? <LoginForm /> : <SignupForm onRegistered={() => setMode('login')} />}
      </div>
    </div>
  );
}
