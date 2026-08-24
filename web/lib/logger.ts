/**
 * Environment-aware logger: everything in development, warnings and errors only
 * in production (errors also go to Sentry).
 */

import * as Sentry from '@sentry/nextjs';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogOptions {
  context?: string;
  data?: unknown;
}

class Logger {
  private isDevelopment: boolean;

  constructor() {
    this.isDevelopment = process.env.NODE_ENV === 'development';
  }

  /** Development only. */
  debug(message: string, options?: LogOptions): void {
    if (!this.isDevelopment) return;

    this.log('debug', message, options);
  }

  /** Development only. */
  info(message: string, options?: LogOptions): void {
    if (!this.isDevelopment) return;

    this.log('info', message, options);
  }

  /** Always logged. */
  warn(message: string, options?: LogOptions): void {
    this.log('warn', message, options);
  }

  /** Always logged; forwarded to Sentry outside development. */
  error(message: string, options?: LogOptions): void {
    this.log('error', message, options);

    if (!this.isDevelopment) {
      Sentry.captureMessage(message, {
        level: 'error',
        extra: options?.data ? { data: options.data } : undefined,
        tags: options?.context ? { context: options.context } : undefined,
      });
    }
  }

  private log(level: LogLevel, message: string, options?: LogOptions): void {
    const timestamp = new Date().toISOString();
    const context = options?.context ? `[${options.context}]` : '';
    const prefix = `[${timestamp}] [${level.toUpperCase()}]${context}`;

    const logMessage = `${prefix} ${message}`;

    switch (level) {
      case 'debug':
        console.log(logMessage, options?.data || '');
        break;
      case 'info':
        console.info(logMessage, options?.data || '');
        break;
      case 'warn':
        console.warn(logMessage, options?.data || '');
        break;
      case 'error':
        console.error(logMessage, options?.data || '');
        break;
    }
  }

  firestore = {
    read: (collection: string, docId?: string) => {
      this.debug(`Firestore READ: ${collection}${docId ? `/${docId}` : ''}`, {
        context: 'Firestore',
      });
    },

    write: (collection: string, docId?: string, operation: 'create' | 'update' | 'delete' = 'update') => {
      this.debug(`Firestore ${operation.toUpperCase()}: ${collection}${docId ? `/${docId}` : ''}`, {
        context: 'Firestore',
      });
    },

    error: (message: string, error: unknown) => {
      this.error(`Firestore error: ${message}`, {
        context: 'Firestore',
        data: error,
      });
    },
  };

  auth = {
    login: (provider: string) => {
      this.info(`User login attempt with ${provider}`, {
        context: 'Auth',
      });
    },

    logout: () => {
      this.info('User logged out', {
        context: 'Auth',
      });
    },

    error: (message: string, error: unknown) => {
      this.error(`Auth error: ${message}`, {
        context: 'Auth',
        data: error,
      });
    },
  };

  performance = {
    start: (operation: string): number => {
      if (!this.isDevelopment) return 0;
      const startTime = performance.now();
      this.debug(`Starting: ${operation}`, { context: 'Performance' });
      return startTime;
    },

    end: (operation: string, startTime: number): void => {
      if (!this.isDevelopment) return;
      const duration = performance.now() - startTime;
      this.debug(`Completed: ${operation} (${duration.toFixed(2)}ms)`, {
        context: 'Performance',
      });
    },
  };
}

export const logger = new Logger();

export default logger;
