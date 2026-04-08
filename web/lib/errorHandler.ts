/**
 * Error sanitization utility
 * Provides user-friendly error messages while hiding internal implementation details
 */
import * as Sentry from '@sentry/nextjs';

interface FirebaseError {
  code?: string;
  message?: string;
}

/**
 * Maps Firebase error codes to user-friendly messages
 */
const FIREBASE_ERROR_MESSAGES: Record<string, string> = {
  // Authentication errors
  'auth/user-not-found': 'Invalid email or password',
  'auth/wrong-password': 'Invalid email or password',
  'auth/invalid-email': 'Please enter a valid email address',
  'auth/user-disabled': 'This account has been disabled',
  'auth/email-already-in-use': 'An account with this email already exists',
  'auth/weak-password': 'Password is too weak. Please choose a stronger password',
  'auth/too-many-requests': 'Too many failed attempts. Please try again later',
  'auth/operation-not-allowed': 'This operation is not allowed',
  'auth/requires-recent-login': 'Please log out and log in again to continue',

  // Firestore errors
  'permission-denied': 'You do not have permission to perform this action',
  'not-found': 'The requested item could not be found',
  'already-exists': 'This item already exists',
  'resource-exhausted': 'Service is temporarily unavailable. Please try again later',
  'failed-precondition': 'Operation cannot be performed in the current state',
  'aborted': 'Operation was cancelled. Please try again',
  'out-of-range': 'Invalid value provided',
  'unimplemented': 'This feature is not yet available',
  'internal': 'An internal error occurred. Please try again',
  'unavailable': 'Service is temporarily unavailable. Please try again later',
  'data-loss': 'Data may have been lost. Please contact support',
  'unauthenticated': 'You must be logged in to perform this action',

  // Network errors
  'network-request-failed': 'Network error. Please check your connection and try again',
  'timeout': 'Request timed out. Please try again',
};

/**
 * Sanitizes error messages for display to users
 * - In development: Shows full error details for debugging
 * - In production: Shows user-friendly generic messages
 *
 * @param error - The error object to sanitize
 * @returns User-friendly error message
 */
export const sanitizeError = (error: unknown): string => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Log full error in development for debugging
  if (isDevelopment) {
    console.error('[Error Handler - DEV]', error);
  }

  // Handle null/undefined errors
  if (!error) {
    return 'An unknown error occurred';
  }

  // Handle Firebase-specific errors
  if (typeof error === 'object' && error !== null) {
    const firebaseError = error as FirebaseError;

    if (firebaseError.code && FIREBASE_ERROR_MESSAGES[firebaseError.code]) {
      return FIREBASE_ERROR_MESSAGES[firebaseError.code];
    }

    // In development, show the actual error message
    if (isDevelopment && firebaseError.message) {
      return firebaseError.message;
    }
  }

  // Handle string errors
  if (typeof error === 'string') {
    // In production, don't show raw error strings (they might contain internal info)
    if (!isDevelopment) {
      return 'An error occurred. Please try again';
    }
    return error;
  }

  // Handle Error objects
  if (error instanceof Error) {
    // In development, show full error message
    if (isDevelopment) {
      return error.message;
    }

    // In production, check if it's a network error
    if (error.message.toLowerCase().includes('network') ||
        error.message.toLowerCase().includes('fetch')) {
      return 'Network error. Please check your connection';
    }
  }

  // Default fallback
  return isDevelopment
    ? `Unknown error: ${JSON.stringify(error)}`
    : 'An error occurred. Please try again';
};

/**
 * Logs errors to console in development, could be extended to send to error tracking service
 *
 * @param error - The error to log
 * @param context - Optional context about where the error occurred
 */
export const logError = (error: unknown, context?: string): void => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (isDevelopment) {
    console.error(`[Error${context ? ` - ${context}` : ''}]`, error);
  } else {
    console.error('[Error]', context || 'An error occurred');
    if (error instanceof Error) {
      Sentry.captureException(error, { tags: context ? { context } : undefined });
    } else {
      Sentry.captureMessage(String(error), {
        level: 'error',
        tags: context ? { context } : undefined,
      });
    }
  }
};

/**
 * Creates a user-friendly error message from a caught error
 * Combines sanitization with optional logging
 *
 * @param error - The error object
 * @param context - Optional context about where the error occurred
 * @returns User-friendly error message
 */
export const handleError = (error: unknown, context?: string): string => {
  logError(error, context);
  return sanitizeError(error);
};
