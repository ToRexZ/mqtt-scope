// Lint rules: ESLint's recommended set, with the environments each part of
// the app runs in. Run with `npm run lint`.

import js from '@eslint/js';
import globals from 'globals';

const rules = {
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-throw-literal': 'error',
  'no-implicit-coercion': ['error', { allow: ['!!'] }],
  'no-shadow': ['error', { builtinGlobals: false }],
  'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
};

export default [
  { ignores: ['node_modules/', 'dist/', 'test-results/', 'playwright-report/', '.robot/', 'packaging/', 'site/'] },
  js.configs.recommended,
  {
    // The window code: ES modules in a browser (sandboxed, no Node).
    files: ['renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules,
  },
  {
    // The main process and its preload: CommonJS on Node/Electron.
    files: ['main/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },
  {
    // Tests, test helpers and scripts: ES modules on Node; e2e code also runs in the page.
    files: ['test/**/*.mjs', 'scripts/**/*.mjs', '*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules,
  },
];
