// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'

// Mock Firebase to avoid initialization errors in tests
jest.mock('./lib/firebase', () => ({
  app: null,
  auth: null,
  db: null,
  isConfigured: false,
}))

// Mock environment variables for tests
process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-api-key'
process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'test.firebaseapp.com'
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'test-project'
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'test.appspot.com'
process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = '123456789'
process.env.NEXT_PUBLIC_FIREBASE_APP_ID = 'test-app-id'

// Server-side env vars for API route handler tests
process.env.FIREBASE_PROJECT_ID = 'test-project'
process.env.FIREBASE_CLIENT_EMAIL = 'test@test-project.iam.gserviceaccount.com'
process.env.FIREBASE_PRIVATE_KEY = 'test-private-key'
process.env.SESSION_SECRET = 'test-session-secret-must-be-at-least-32-chars-long!!'
// Disable rate limiting in tests (empty string = no Redis connection)
process.env.UPSTASH_REDIS_REST_URL = ''
process.env.UPSTASH_REDIS_REST_TOKEN = ''

// Suppress console errors during tests (optional)
// Uncomment if you want cleaner test output
// const originalError = console.error
// beforeAll(() => {
//   console.error = (...args) => {
//     if (
//       typeof args[0] === 'string' &&
//       args[0].includes('Warning: ReactDOM.render')
//     ) {
//       return
//     }
//     originalError.call(console, ...args)
//   }
// })
//
// afterAll(() => {
//   console.error = originalError
// })
