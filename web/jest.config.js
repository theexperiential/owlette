// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextJest = require('next/jest')

/** @type {import('jest').Config} */
const createJestConfig = nextJest({
  // Loads next.config.js + .env files into the test environment.
  dir: './',
})

const config = {
  clearMocks: true,

  collectCoverage: false,

  coverageDirectory: 'coverage',

  collectCoverageFrom: [
    'app/**/*.{js,jsx,ts,tsx}',
    'components/**/*.{js,jsx,ts,tsx}',
    'contexts/**/*.{js,jsx,ts,tsx}',
    'hooks/**/*.{js,jsx,ts,tsx}',
    'lib/**/*.{js,jsx,ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/.next/**',
    '!**/coverage/**',
    '!**/jest.config.js',
  ],

  testEnvironment: 'jsdom',

  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

  moduleNameMapper: {
    // CSS modules
    '^.+\\.module\\.(css|sass|scss)$': 'identity-obj-proxy',

    // plain CSS
    '^.+\\.(css|sass|scss)$': '<rootDir>/__mocks__/styleMock.js',

    // images
    '^.+\\.(png|jpg|jpeg|gif|webp|avif|ico|bmp|svg)$': '<rootDir>/__mocks__/fileMock.js',

    // tsconfig path aliases
    '^@/(.*)$': '<rootDir>/$1',
  },

  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/.next/',
    '__tests__/api/helpers/',
    '/e2e/', // Playwright specs — use `npm run e2e`, not jest.
    '/__tests__/rules/', // Firestore rules tests — use `npm run test:rules` (boots emulator).
  ],

  transformIgnorePatterns: [
    '/node_modules/',
    '^.+\\.module\\.(css|sass|scss)$',
  ],
}

// Exported as a call so next/jest can load the async Next.js config.
//
// next/jest PREPENDS its own node_modules patterns, and transformIgnorePatterns
// is OR-ed — a file matching any entry is left untransformed. So appending an
// exception to `config` above cannot work; next's pattern still matches first.
// The resolved config has to be rewritten instead.
//
// Why: firebase-admin 14 reaches jose (via jwks-rsa), and jose 6 is ESM-only
// (`type: module`, no CJS build), which jest's CJS runtime cannot parse. Suites
// that mock `@/lib/firebase-admin` never load it; the few that exercise the real
// bootstrap do, and they fail on `Unexpected token 'export'` without this.
const ESM_ONLY_DEPS = ['jose']

// Windows resolves module paths with backslashes, POSIX with slashes; match either.
const SEP = '[\\\\/]'

module.exports = async () => {
  const resolved = await createJestConfig(config)()
  resolved.transformIgnorePatterns = [
    `node_modules${SEP}(?!(${ESM_ONLY_DEPS.join('|')})${SEP})`,
    '^.+\\.module\\.(css|sass|scss)$',
  ]
  return resolved
}
