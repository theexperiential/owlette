// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'

// Firebase mock — the real SDK throws on init in tests
jest.mock('./lib/firebase', () => ({
  app: null,
  auth: null,
  db: null,
  isConfigured: false,
}))

// Client env
process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-api-key'
process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'test.firebaseapp.com'
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'test-project'
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'test.appspot.com'
process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = '123456789'
process.env.NEXT_PUBLIC_FIREBASE_APP_ID = 'test-app-id'

// Server env, for API route handler tests
process.env.FIREBASE_PROJECT_ID = 'test-project'
process.env.FIREBASE_CLIENT_EMAIL = 'test@test-project.iam.gserviceaccount.com'
process.env.FIREBASE_PRIVATE_KEY = 'test-private-key'
process.env.SESSION_SECRET = 'test-session-secret-must-be-at-least-32-chars-long!!'
// Empty string = no Redis connection = no rate limiting
process.env.UPSTASH_REDIS_REST_URL = ''
process.env.UPSTASH_REDIS_REST_TOKEN = ''
