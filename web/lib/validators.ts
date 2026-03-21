/**
 * Password validation utility
 * Enforces 8+ character minimum with complexity requirements
 */

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

/**
 * Validates password strength
 * Requires:
 * - At least 8 characters
 * - At least 2 of: lowercase, uppercase, numbers, special characters
 */
export const validatePassword = (password: string): ValidationResult => {
  // Check minimum length
  if (password.length < 8) {
    return {
      isValid: false,
      error: 'Password must be at least 8 characters',
    };
  }

  // Check complexity - at least 2 of these categories
  let complexity = 0;

  if (/[a-z]/.test(password)) complexity++; // Has lowercase
  if (/[A-Z]/.test(password)) complexity++; // Has uppercase
  if (/[0-9]/.test(password)) complexity++; // Has numbers
  if (/[^a-zA-Z0-9]/.test(password)) complexity++; // Has special characters

  if (complexity < 2) {
    return {
      isValid: false,
      error: 'Password must include at least 2 of: lowercase, uppercase, numbers, or special characters',
    };
  }

  return { isValid: true };
};

/**
 * Validates email format
 */
export const validateEmail = (email: string): ValidationResult => {
  // Require at least 2-char local part, 2-char domain, and 2-char TLD
  const emailRegex = /^[^\s@]{2,}@[^\s@]{2,}\.[^\s@]{2,}$/;

  if (!email || email.trim() === '') {
    return {
      isValid: false,
      error: 'Email is required',
    };
  }

  if (!emailRegex.test(email)) {
    return {
      isValid: false,
      error: 'Please enter a valid email address',
    };
  }

  return { isValid: true };
};

/**
 * Validates process name
 * - Max 255 characters
 * - Only alphanumeric, spaces, hyphens, underscores, and periods
 */
export const validateProcessName = (name: string): ValidationResult => {
  if (!name || name.trim() === '') {
    return {
      isValid: false,
      error: 'Process name is required',
    };
  }

  if (name.length > 255) {
    return {
      isValid: false,
      error: 'Process name too long (max 255 characters)',
    };
  }

  if (!/^[a-zA-Z0-9\s\-_.]+$/.test(name)) {
    return {
      isValid: false,
      error: 'Process name contains invalid characters. Use only letters, numbers, spaces, hyphens, underscores, and periods.',
    };
  }

  return { isValid: true };
};

/**
 * Validates Windows executable path
 * - Must be valid Windows path format
 * - No path traversal (..)
 * - Must have file extension
 */
export const validateExecutablePath = (path: string): ValidationResult => {
  if (!path || path.trim() === '') {
    return {
      isValid: false,
      error: 'Executable path is required',
    };
  }

  // Check for path traversal
  if (path.includes('..')) {
    return {
      isValid: false,
      error: 'Path traversal is not allowed',
    };
  }

  // Basic Windows path validation
  // Accepts: C:\path\to\file.exe or C:/path/to/file.exe
  const windowsPathRegex = /^[A-Za-z]:[\\\/][\w\s\-_.\\\/()]+\.\w+$/;

  if (!windowsPathRegex.test(path)) {
    return {
      isValid: false,
      error: 'Invalid executable path format. Use format: C:/Program Files/app.exe',
    };
  }

  return { isValid: true };
};

/**
 * Validates numeric string within range
 */
export const validateNumericString = (
  value: string,
  min: number,
  max: number,
  fieldName: string
): ValidationResult => {
  const num = parseInt(value, 10);

  if (isNaN(num)) {
    return {
      isValid: false,
      error: `${fieldName} must be a number`,
    };
  }

  if (num < min || num > max) {
    return {
      isValid: false,
      error: `${fieldName} must be between ${min} and ${max}`,
    };
  }

  return { isValid: true };
};

/**
 * Validates enum value
 */
export const validateEnum = <T extends string>(
  value: string,
  allowedValues: readonly T[],
  fieldName: string
): ValidationResult => {
  if (!allowedValues.includes(value as T)) {
    return {
      isValid: false,
      error: `Invalid ${fieldName}. Allowed values: ${allowedValues.join(', ')}`,
    };
  }

  return { isValid: true };
};

/**
 * Reserved site IDs that cannot be used
 */
const RESERVED_SITE_IDS = [
  'admin',
  'api',
  'auth',
  'config',
  'dashboard',
  'deployments',
  'login',
  'logout',
  'register',
  'settings',
  'setup',
  'sites',
  'users',
] as const;

/**
 * Validates site ID (slug format)
 * - 3-50 characters
 * - Lowercase letters, numbers, hyphens, underscores
 * - Must start with letter
 * - Cannot be reserved word
 */
export const validateSiteId = (siteId: string): ValidationResult => {
  if (!siteId || siteId.trim() === '') {
    return {
      isValid: false,
      error: 'Site ID is required',
    };
  }

  // Check length
  if (siteId.length < 3) {
    return {
      isValid: false,
      error: 'Site ID must be at least 3 characters',
    };
  }

  if (siteId.length > 50) {
    return {
      isValid: false,
      error: 'Site ID must be 50 characters or less',
    };
  }

  // Check format: lowercase, letters, numbers, hyphens, underscores
  if (!/^[a-z][a-z0-9_-]*$/.test(siteId)) {
    return {
      isValid: false,
      error: 'Site ID must start with a letter and contain only lowercase letters, numbers, hyphens, and underscores',
    };
  }

  // Check for reserved words
  if (RESERVED_SITE_IDS.includes(siteId as any)) {
    return {
      isValid: false,
      error: `"${siteId}" is a reserved word and cannot be used as a site ID`,
    };
  }

  return { isValid: true };
};

/**
 * Generates a URL-friendly slug from a site name
 * Example: "New York Office" -> "new-york-office"
 */
export const generateSiteIdFromName = (siteName: string): string => {
  return siteName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
};

const ADJECTIVES = [
  'amber', 'bold', 'calm', 'dark', 'eager', 'fair', 'glad', 'hazy', 'keen', 'lush',
  'mild', 'neat', 'pale', 'quick', 'rare', 'safe', 'tall', 'vast', 'warm', 'zesty',
  'airy', 'blue', 'cool', 'deep', 'even', 'fine', 'gold', 'high', 'idle', 'just',
  'kind', 'lean', 'mint', 'nova', 'open', 'pure', 'rich', 'soft', 'tidy', 'wise',
  'aqua', 'bay', 'cozy', 'dusk', 'elm', 'frost', 'gray', 'hue', 'ivy', 'jade',
  'knit', 'lime', 'moss', 'neon', 'oak', 'pine', 'quilt', 'reef', 'sage', 'teal',
];

const NOUNS = [
  'arch', 'barn', 'cave', 'dawn', 'echo', 'fern', 'glen', 'hive', 'isle', 'jade',
  'kite', 'lake', 'mesa', 'nest', 'opal', 'peak', 'quay', 'reef', 'star', 'tide',
  'vale', 'wave', 'yard', 'apex', 'bay', 'cove', 'dell', 'elm', 'fort', 'gate',
  'hall', 'ink', 'jet', 'knoll', 'loft', 'mist', 'nook', 'orb', 'pond', 'ridge',
  'spire', 'trail', 'urn', 'vine', 'wren', 'yew', 'zen', 'bloom', 'crest', 'dune',
  'flint', 'grove', 'heath', 'iron', 'brook', 'cliff', 'drift', 'field', 'glow', 'husk',
];

/**
 * Generates a random two-word site ID like "calm-reef" or "bold-peak"
 */
export const generateRandomSiteId = (): string => {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
};
