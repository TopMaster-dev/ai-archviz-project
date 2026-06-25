import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { lpGalleryPlugin } from './vite-plugins/lpGallery.js';

// テスト専用設定（アプリの vite.config.ts のローカル API ミドルウェア等の副作用を避けるため分離）。
// lpGalleryPlugin は LandingPage が import する 'virtual:lp-gallery' をテストでも解決するために必要
// （AuthScreen→LandingPage が import 連鎖に乗るため）。
export default defineConfig({
  plugins: [react(), lpGalleryPlugin()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['**/*.test.{ts,tsx}'],
  },
});
