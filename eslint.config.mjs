import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'out/**', 'test/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // Live-check scripts are run by hand against hq copies; keep them readable, not strict.
  { files: ['scripts/**'], rules: { 'no-console': 'off', '@typescript-eslint/no-unused-vars': 'off', 'no-empty': 'off' } },
  // The harness main process is plain CommonJS (Electron loads it directly).
  { files: ['scripts/shots/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
