/**
 * Tests for errorHandler utility
 *
 * Tests the error sanitization and Firebase error mapping functionality.
 */

import { sanitizeError, handleError, logError } from '@/lib/errorHandler';

describe('errorHandler', () => {
  // Capture console output for testing
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe('sanitizeError', () => {
    it('should return user-friendly message for Firebase auth/user-not-found error', () => {
      const error = { code: 'auth/user-not-found', message: 'Firebase: Error (auth/user-not-found).' };
      const result = sanitizeError(error);
      expect(result).toBe('Invalid email or password');
    });

    it('should return user-friendly message for Firebase auth/wrong-password error', () => {
      const error = { code: 'auth/wrong-password', message: 'Firebase: Error (auth/wrong-password).' };
      const result = sanitizeError(error);
      expect(result).toBe('Invalid email or password');
    });

    it('should return user-friendly message for Firebase auth/email-already-in-use error', () => {
      const error = { code: 'auth/email-already-in-use', message: 'Firebase: Error (auth/email-already-in-use).' };
      const result = sanitizeError(error);
      expect(result).toBe('An account with this email already exists');
    });

    it('should return user-friendly message for Firebase auth/weak-password error', () => {
      const error = { code: 'auth/weak-password', message: 'Firebase: Error (auth/weak-password).' };
      const result = sanitizeError(error);
      expect(result).toBe('Password is too weak. Please choose a stronger password');
    });

    it('should return user-friendly message for Firebase auth/invalid-email error', () => {
      const error = { code: 'auth/invalid-email', message: 'Firebase: Error (auth/invalid-email).' };
      const result = sanitizeError(error);
      expect(result).toBe('Please enter a valid email address');
    });

    it('should return user-friendly message for Firebase auth/network-request-failed error', () => {
      const error = { code: 'auth/network-request-failed', message: 'Firebase: Error (auth/network-request-failed).' };
      const result = sanitizeError(error);
      expect(result).toBe('An error occurred. Please try again');
    });

    it('should return user-friendly message for Firebase permission-denied error', () => {
      const error = { code: 'permission-denied', message: 'Missing or insufficient permissions.' };
      const result = sanitizeError(error);
      expect(result).toBe('You do not have permission to perform this action');
    });

    it('should return user-friendly message for Firebase not-found error', () => {
      const error = { code: 'not-found', message: 'Document not found.' };
      const result = sanitizeError(error);
      expect(result).toBe('The requested item could not be found');
    });

    it('should return error message for unknown Firebase error codes', () => {
      const error = { code: 'auth/unknown-error', message: 'Unknown error occurred.' };
      const result = sanitizeError(error);
      expect(result).toBe('An error occurred. Please try again');
    });

    it('should return error message for plain Error objects', () => {
      const error = new Error('Something went wrong');
      const result = sanitizeError(error);
      expect(result).toBe('An error occurred. Please try again');
    });

    it('should return default message for string errors', () => {
      const error = 'Simple error string';
      const result = sanitizeError(error);
      expect(result).toBe('An error occurred. Please try again');
    });

    it('should return default message for unknown error types', () => {
      const error = { foo: 'bar' };
      const result = sanitizeError(error);
      expect(result).toBe('An error occurred. Please try again');
    });

    it('should return default message for null/undefined', () => {
      expect(sanitizeError(null)).toBe('An unknown error occurred');
      expect(sanitizeError(undefined)).toBe('An unknown error occurred');
    });
  });

  describe('logError', () => {
    it('should log error to console', () => {
      const error = new Error('Test error');
      logError(error);
      expect(consoleErrorSpy).toHaveBeenCalledWith('[Error]', 'An error occurred');
    });

    it('should log error with context', () => {
      const error = new Error('Test error');
      const context = 'User login';
      logError(error, context);
      expect(consoleErrorSpy).toHaveBeenCalledWith('[Error]', context);
    });
  });

  describe('handleError', () => {
    it('should sanitize and log error', () => {
      const error = { code: 'auth/user-not-found', message: 'Firebase: Error (auth/user-not-found).' };
      const result = handleError(error);

      expect(result).toBe('Invalid email or password');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[Error]', 'An error occurred');
    });

    it('should sanitize and log error with context', () => {
      const error = { code: 'auth/wrong-password', message: 'Firebase: Error (auth/wrong-password).' };
      const context = 'Sign in attempt';
      const result = handleError(error, context);

      expect(result).toBe('Invalid email or password');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[Error]', context);
    });
  });
});
