/**
 * Firebase env-var validation. Development warns and continues; production
 * throws and blocks startup.
 */

export interface EnvValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

const REQUIRED_FIREBASE_ENV_VARS = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
] as const;

/** Substrings that mark a value as an unfilled placeholder. */
const INVALID_VALUES = [
  'placeholder',
  'your-',
  'example-',
  'undefined',
  'null',
  '',
];

function isInvalidValue(value: string | undefined): boolean {
  if (!value) return true;

  return INVALID_VALUES.some((invalid) =>
    value.toLowerCase().includes(invalid.toLowerCase())
  );
}

export function validateEnvironment(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  REQUIRED_FIREBASE_ENV_VARS.forEach((envVar) => {
    const value = process.env[envVar];

    if (!value) {
      errors.push(`Missing required environment variable: ${envVar}`);
    } else if (isInvalidValue(value)) {
      errors.push(
        `Invalid value for ${envVar}: "${value}" (appears to be a placeholder)`
      );
    }
  });

  if (errors.length > 0) {
    errors.push('');
    errors.push('To fix this:');
    errors.push('1. Copy web/.env.example to web/.env.local');
    errors.push('2. Fill in your Firebase project credentials from Firebase Console');
    errors.push('3. Restart the development server');
    errors.push('');
    errors.push(
      'Get credentials from: https://console.firebase.google.com/ → Project Settings → General'
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/** Warns in development, throws in production. */
export function validateEnvironmentOrThrow(): void {
  const result = validateEnvironment();

  if (!result.isValid) {
    const errorMessage = [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '⚠️  FIREBASE CONFIGURATION ERROR',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      ...result.errors,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');

    if (process.env.NODE_ENV === 'development') {
      console.warn(errorMessage);
      console.warn('⚠️  Running with invalid Firebase configuration');
      console.warn('⚠️  Some features may not work correctly');
      return;
    }

    throw new Error(errorMessage);
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('✅ Firebase environment variables validated successfully');
  }
}

/** Message safe to render in the UI. */
export function getFirebaseConfigErrorMessage(): string {
  const result = validateEnvironment();

  if (result.isValid) {
    return '';
  }

  return `Firebase is not configured properly. Please check your environment variables and restart the application.`;
}

export function isFirebaseConfigured(): boolean {
  const result = validateEnvironment();
  return result.isValid;
}

export function getFirebaseConfigErrors(): string[] {
  const result = validateEnvironment();
  return result.errors;
}

export function validateFirebaseConfigValue(
  key: string,
  value: string | undefined
): { isValid: boolean; error?: string } {
  if (!value) {
    return {
      isValid: false,
      error: `${key} is missing`,
    };
  }

  if (isInvalidValue(value)) {
    return {
      isValid: false,
      error: `${key} appears to be a placeholder: "${value}"`,
    };
  }

  return { isValid: true };
}
