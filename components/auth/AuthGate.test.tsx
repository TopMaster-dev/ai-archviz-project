import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// 未構成 → ゲストモード（認証ゲートなし）であることを検証。
vi.mock('../../lib/db/supabaseClient.js', () => ({
  isSupabaseConfigured: () => false,
  getSupabase: () => null,
}));

import { AuthProvider } from '../../lib/auth/AuthContext.js';
import { AuthGate } from './AuthGate.js';

describe('AuthGate', () => {
  it('renders the app without a login gate when Supabase is unconfigured (guest mode)', () => {
    render(
      <AuthProvider>
        <AuthGate>
          <div>APP_CONTENT</div>
        </AuthGate>
      </AuthProvider>,
    );
    expect(screen.getByText('APP_CONTENT')).toBeTruthy();
  });
});
