/**
 * Environment-aware logging utility
 * - Development: Logs everything with detailed context
 * - Production: Only logs warnings and errors to minimize console noise
 */

import * as Sentry from '@sentry/nextjs';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogOptions {
  context?: string;
  data?: any;
}

class Logger {
  private isDevelopment: boolean;

  constructor() {
    this.isDevelopment = process.env.NODE_ENV === 'development';
  }

  /**
   * Debug logs - only in development
   * Use for detailed debugging information
   */
  debug(message: string, options?: LogOptions): void {
    if (!this.isDevelopment) return;

    this.log('debug', message, options);
  }

  /**
   * Info logs - only in development
   * Use for general informational messages
   */
  info(message: string, options?: LogOptions): void {
    if (!this.isDevelopment) return;

    this.log('info', message, options);
  }

  /**
   * Warning logs - always logged
   * Use for recoverable errors or concerning situations
   */
  warn(message: string, options?: LogOptions): void {
    this.log('warn', message, options);
  }

  /**
   * Error logs - always logged
   * Use for errors and exceptions
   * In production, could be sent to error tracking service
   */
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

  /**
   * Internal log method
   */
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

  /**
   * Firestore operation logger - specialized for Firebase operations
   */
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

  /**
   * Authentication logger - specialized for auth operations
   */
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

  /**
   * Performance logger - for tracking performance metrics
   */
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

// Export singleton instance
export const logger = new Logger();

// Export default for convenient importing
export default logger;
