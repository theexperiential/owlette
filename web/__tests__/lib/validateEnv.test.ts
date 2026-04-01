/**
 * Tests for validateEnv utility
 *
 * Tests environment variable validation functionality.
 */

import {
  validateEnvironment,
  validateEnvironmentOrThrow,
  isFirebaseConfigured,
  getFirebaseConfigErrorMessage,
  validateFirebaseConfigValue,
} from '@/lib/validateEnv';

describe('validateEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('validateEnvironment', () => {
    it('should return valid when all Firebase env vars are set', () => {
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'real-api-key';
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'project.firebaseapp.com';
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'project-id';
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'project.appspot.com';
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = '123456789';
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID = 'app-id';

      const result = validateEnvironment();

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should return invalid when Firebase env vars are missing', () => {
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '';
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = '';

      const result = validateEnvironment();

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Missing required environment variable');
    });

    it('should return invalid when Firebase env vars have placeholder values', () => {
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'placeholder';
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'your-project.firebaseapp.com';
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'example-project';

      const result = validateEnvironment();

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('placeholder'))).toBe(true);
    });

    it('should include helpful instructions when validation fails', () => {
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '';

      const result = validateEnvironment();

      expect(result.errors.some(e => e.includes('To fix this:'))).toBe(true);
      expect(result.errors.some(e => e.includes('.env.local'))).toBe(true);
    });
  });

  describe('validateEnvironmentOrThrow', () => {
    let consoleWarnSpy: jest.SpyInstance;
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => {
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('should not throw in development mode with invalid config', () => {
      (process.env as Record<string, string>).NODE_ENV = 'development';
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '';

      expect(() => validateEnvironmentOrThrow()).not.toThrow();
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should throw in production mode with invalid config', () => {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '';

      expect(() => validateEnvironmentOrThrow()).toThrow();
    });

    it('should log success in development mode with valid config', () => {
      (process.env as Record<string, string>).NODE_ENV = 'development';
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'real-api-key';
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'project.firebaseapp.com';
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'project-id';
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'project.appspot.com';
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = '123456789';
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID = 'app-id';

      validateEnvironmentOrThrow();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Firebase environment variables validated successfully')
      );
    });
  });

  describe('isFirebaseConfigured', () => {
    it('should return true when all Firebase env vars are valid', () => {
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'real-api-key';
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'project.firebaseapp.com';
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'project-id';
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'project.appspot.com';
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = '123456789';
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID = 'app-id';

      expect(isFirebaseConfigured()).toBe(true);
    });

    it('should return false when Firebase env vars are missing', () => {
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '';

      expect(isFirebaseConfigured()).toBe(false);
    });
  });

  describe('getFirebaseConfigErrorMessage', () => {
    it('should return empty string when config is valid', () => {
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'real-api-key';
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'project.firebaseapp.com';
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'project-id';
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'project.appspot.com';
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = '123456789';
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID = 'app-id';

      expect(getFirebaseConfigErrorMessage()).toBe('');
    });

    it('should return error message when config is invalid', () => {
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '';

      const message = getFirebaseConfigErrorMessage();

      expect(message).toContain('Firebase is not configured properly');
    });
  });

  describe('validateFirebaseConfigValue', () => {
    it('should return valid for real config value', () => {
      const result = validateFirebaseConfigValue('API_KEY', 'real-api-key-12345');

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return invalid for missing value', () => {
      const result = validateFirebaseConfigValue('API_KEY', undefined);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('is missing');
    });

    it('should return invalid for placeholder value', () => {
      const result = validateFirebaseConfigValue('API_KEY', 'placeholder');

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('placeholder');
    });

    it('should return invalid for example values', () => {
      const result = validateFirebaseConfigValue('PROJECT_ID', 'your-project-id');

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('placeholder');
    });
  });
});
