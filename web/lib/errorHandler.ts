/** User-facing error strings that don't leak internal implementation detail. */
import * as Sentry from '@sentry/nextjs';

interface FirebaseError {
  code?: string;
  message?: string;
}

const FIREBASE_ERROR_MESSAGES: Record<string, string> = {
  'auth/user-not-found': 'Invalid email or password',
  'auth/wrong-password': 'Invalid email or password',
  'auth/invalid-email': 'Please enter a valid email address',
  'auth/user-disabled': 'This account has been disabled',
  'auth/email-already-in-use': 'An account with this email already exists',
  'auth/weak-password': 'Password is too weak. Please choose a stronger password',
  'auth/too-many-requests': 'Too many failed attempts. Please try again later',
  'auth/operation-not-allowed': 'This operation is not allowed',
  'auth/requires-recent-login': 'Please log out and log in again to continue',
  // The SDK already signed the user out (`_logoutIfInvalidated` in @firebase/auth).
  'auth/user-token-expired': 'Your session expired. Please sign in again',
  'auth/invalid-user-token': 'Your session expired. Please sign in again',

  // The first two are in POPUP_UNAVAILABLE_CODES (lib/inAppBrowser), so /login and
  // /register show inline remediation and these strings serve other callers only.
  // `auth/web-storage-unsupported` is deliberately excluded from that set — the
  // inline notice points at an email fallback needing the same blocked storage.
  'auth/popup-blocked': 'This browser blocked the sign-in window. Open owlette.app in your browser, or sign in with your email',
  'auth/operation-not-supported-in-this-environment': 'Google sign-in is not available in this browser. Open owlette.app in your browser, or sign in with your email',
  'auth/web-storage-unsupported': 'This browser is blocking the storage sign-in needs. Try another browser, or sign in with your email',

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

  'auth/network-request-failed': 'Network error. Please check your connection and try again',
  'timeout': 'Request timed out. Please try again',
};

/** Full detail in development, generic user-facing strings in production. */
export const sanitizeError = (error: unknown): string => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (isDevelopment) {
    console.error('[Error Handler - DEV]', error);
  }

  if (!error) {
    return 'An unknown error occurred';
  }

  if (typeof error === 'object' && error !== null) {
    const firebaseError = error as FirebaseError;

    if (firebaseError.code && FIREBASE_ERROR_MESSAGES[firebaseError.code]) {
      return FIREBASE_ERROR_MESSAGES[firebaseError.code];
    }

    if (isDevelopment && firebaseError.message) {
      return firebaseError.message;
    }
  }

  if (typeof error === 'string') {
    // raw strings may carry internal detail
    if (!isDevelopment) {
      return 'An error occurred. Please try again';
    }
    return error;
  }

  if (error instanceof Error) {
    if (isDevelopment) {
      return error.message;
    }

    if (error.message.toLowerCase().includes('network') ||
        error.message.toLowerCase().includes('fetch')) {
      return 'Network error. Please check your connection';
    }
  }

  return isDevelopment
    ? `Unknown error: ${JSON.stringify(error)}`
    : 'An error occurred. Please try again';
};

/**
 * Extra Sentry scope for one report. Motivating case: the raw user-agent — Sentry's
 * parsed browser family collapses every unrecognised iOS webview to one label.
 */
export interface ErrorDetail {
  /** Sentry tags: short, low-cardinality values only. */
  tags?: Record<string, string>;
  /** Larger / higher-cardinality values (user agents, ids, payloads). */
  extra?: Record<string, unknown>;
}

/** Console in development, Sentry in production. */
export const logError = (error: unknown, context?: string, detail?: ErrorDetail): void => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (isDevelopment) {
    console.error(`[Error${context ? ` - ${context}` : ''}]`, error, detail?.extra ?? '');
  } else {
    console.error('[Error]', context || 'An error occurred');
    const tags = { ...(context ? { context } : {}), ...(detail?.tags ?? {}) };
    const scope = {
      tags: Object.keys(tags).length > 0 ? tags : undefined,
      extra: detail?.extra,
    };
    if (error instanceof Error) {
      Sentry.captureException(error, scope);
    } else {
      Sentry.captureMessage(String(error), {
        level: 'error',
        ...scope,
      });
    }
  }
};

/** logError + sanitizeError in one call. */
export const handleError = (error: unknown, context?: string): string => {
  logError(error, context);
  return sanitizeError(error);
};
