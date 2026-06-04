import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// テスト専用設定（アプリの vite.config.ts のローカル API ミドルウェア等の副作用を避けるため分離）。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['**/*.test.{ts,tsx}'],
  },
});
