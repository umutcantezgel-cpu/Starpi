import js from '@eslint/js';
import globals from 'globals';

const PURE = ['src/js/core/**/*.js', 'src/js/rag/bm25.js', 'src/js/rag/chunker.js'];

export default [
  {
    ignores: ['dist/**', '.build/**', 'node_modules/**', 'backend/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-eval': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'log'] }],
    },
  },
  {
    files: ['src/js/**/*.js'],
    ignores: PURE,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        __STARPI_SUPABASE_URL__: 'readonly',
        __STARPI_SUPABASE_ANON_KEY__: 'readonly',
        __STARPI_VERSION__: 'readonly',
      },
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-script-url': 'error',
    },
  },
  {
    // Pure modules (the source check, receipts, chunking, BM25) run in the browser, in workers and in
    // Node, so they may only use globals all three share.
    files: PURE,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals['shared-node-browser'], crypto: 'readonly' },
    },
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['src/sw.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', '*.config.js', '*.config.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // Playwright callbacks passed to page.evaluate()/addInitScript() run in the browser.
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
