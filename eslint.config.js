// ESLint flat config (ESLint 9+). Run: `npm run lint`
// 目的: 「特定の個人にしか解読できない実装」を避け、標準的で読みやすいコードを担保する。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'public/models', '**/*.glb', '**/*.gltf'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // 段階的導入のため、未使用変数は警告（`_` 接頭辞で意図的無視を許可）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // プロトタイプ由来の any を一括禁止にすると移行が止まるため、当面は警告に緩和
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // サーバーレス関数 / 設定ファイルは Node 環境
    files: ['api/**/*.ts', '*.config.{js,ts}', 'vite.config.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
