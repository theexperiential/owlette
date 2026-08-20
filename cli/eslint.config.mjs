// Flat ESLint config for @owlette/cli. Non-type-aware preset on purpose: it
// skips the project-wide TS program load. Type-aware rules are a follow-up —
// more coverage, noticeably slower.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // API response shapes are hand-validated at the call site, so `as` and
      // `unknown` are idiomatic here rather than smells.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // jest matchers and module augmentation trip these constantly.
    files: ['__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  },
];
