// Flat ESLint config for the @owlette/cli package.
//
// Uses the typescript-eslint recommended preset (non-type-aware) so it
// runs fast against `src/**/*.ts` and `__tests__/**/*.ts` without the
// project-wide TypeScript program load. Tightening to type-aware rules
// is a follow-up — would catch more but adds noticeable lint latency.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Honour `_`-prefixed identifiers as intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // The CLI talks to APIs whose response shapes are validated by
      // hand at the call site — `as` and `unknown` are common idioms,
      // not smells worth blocking on at the lint layer.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Test files: relax the empty-function + no-namespace rules; jest
    // matchers and module-augmentation patterns trip them often.
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
