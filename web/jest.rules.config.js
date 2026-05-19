// Jest config for Firestore rules tests.
// Loaded only by `npm run test:rules` (which boots the firestore emulator first).
// Kept separate from `jest.config.js` so that regular `npm test` doesn't try
// to run rules specs against a missing emulator.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  clearMocks: true,
  collectCoverage: false,
  testEnvironment: 'node',
  // Only rules specs.
  testMatch: ['<rootDir>/__tests__/rules/**/*.test.[jt]s?(x)'],
  // Don't pull in jest.setup.js — it mocks `lib/firebase` and pollutes env
  // vars, both irrelevant (and harmful) for rules tests that talk to the
  // emulator directly via `@firebase/rules-unit-testing`.
  setupFilesAfterEnv: [],
  testPathIgnorePatterns: ['/node_modules/', '/.next/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  transformIgnorePatterns: [
    '/node_modules/',
  ],
};

module.exports = createJestConfig(config);
