/**
 * Config loader for the owlette CLI.
 *
 * Resolution order (first-wins for each field):
 *   1. Environment: OWLETTE_TOKEN | OWLETTE_API_URL | OWLETTE_PROFILE |
 *      OWLETTE_ENVIRONMENT (with legacy ROOST_* fallback through
 *      2026-10-01 — emits a one-time deprecation per process).
 *   2. Stored credential for the active profile (OS keychain when available,
 *      otherwise ~/.config/owlette/credentials.json).
 *   3. Profile in ~/.config/owlette/config.toml (default profile: `default`).
 *      On first access, if the new path doesn't exist but
 *      ~/.config/roost/config.toml does, the legacy file is copied to the
 *      new location once and a one-time migration notice is printed.
 *   4. Built-in defaults (apiUrl → https://owlette.app).
 *
 * Config file schema (TOML):
 *
 *     # top-level default values
 *     api_url = "https://owlette.app"
 *     environment = "live"          # 'live' | 'test'
 *
 *     [profiles.default]
 *     token = "owk_live_..."
 *     api_url = "https://owlette.app"
 *
 *     [profiles.dev]
 *     token = "owk_test_..."
 *     api_url = "https://dev.owlette.app"
 *     environment = "test"
 *
 * The active profile is chosen by OWLETTE_PROFILE / ROOST_PROFILE env or
 * --profile CLI flag; default is 'default'.
 *
 * The config file is read lazily on first `loadConfig()` call and cached.
 * Tests pass `opts.reload: true` to bypass the cache.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { parse as parseToml } from 'smol-toml';
import {
  defaultCredentialPath,
  readStoredCredential,
  type CredentialBackend,
} from './credentialStore';

export const DEFAULT_API_URL = 'https://owlette.app';

/**
 * Hard cutoff for the legacy `ROOST_*` env vars + `~/.config/roost/`
 * fallback. After this date the deprecation paths can be deleted.
 */
export const LEGACY_REMOVAL_DATE = '2026-10-01';

export interface OwletteConfig {
  /** Bearer token — `owk_live_...` or `owk_test_...`. */
  token: string | null;
  /** Base URL the CLI points at. Default: https://owlette.app */
  apiUrl: string;
  /** Environment tag emitted in audit events + used for idempotency keys. */
  environment: 'live' | 'test' | null;
  /** Active profile name (for diagnostics). */
  profile: string;
  /** Absolute path to the config file; null when no file was found. */
  configPath: string | null;
  /** Absolute path to the fallback credential file when used. */
  credentialPath: string | null;
  /** Where the active token came from, if any. */
  credentialSource: 'env' | 'keychain' | 'token-file' | 'config' | null;
}

export interface LoadConfigOpts {
  /** Override ~/.config/owlette/config.toml lookup (used in tests). */
  configPath?: string;
  /** Override ~/.config/owlette/credentials.json lookup (used in tests). */
  credentialPath?: string;
  /** Force credential backend selection (used in tests and diagnostics). */
  credentialBackend?: CredentialBackend;
  /** Force re-read (bypasses the module-level cache). */
  reload?: boolean;
  /**
   * Active profile name; defaults to OWLETTE_PROFILE env (or legacy
   * ROOST_PROFILE) or 'default'.
   */
  profile?: string;
  /** Read-env overrides (default: process.env). Used for test isolation. */
  env?: NodeJS.ProcessEnv;
  /**
   * Legacy config path probed when the new path doesn't exist. Defaults
   * to ~/.config/roost/config.toml. Tests override.
   */
  legacyConfigPath?: string;
  /**
   * Stream to emit one-time deprecation / migration notices to. Defaults
   * to process.stderr. Tests can pass a writable buffer.
   */
  warnStream?: { write(s: string): unknown };
}

let cache: { config: OwletteConfig; key: string } | null = null;

/** Once-per-process flags so the deprecation warnings don't spam. */
const warned = {
  envFallback: false,
  configMigrated: false,
};

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'owlette', 'config.toml');
}

export function legacyConfigPath(): string {
  return join(homedir(), '.config', 'roost', 'config.toml');
}

function readEnvWithLegacyFallback(
  env: NodeJS.ProcessEnv,
  warn: { write(s: string): unknown },
  primary: 'OWLETTE_TOKEN' | 'OWLETTE_API_URL' | 'OWLETTE_PROFILE' | 'OWLETTE_ENVIRONMENT',
  legacy: 'ROOST_TOKEN' | 'ROOST_API_URL' | 'ROOST_PROFILE' | 'ROOST_ENVIRONMENT',
): string | undefined {
  const primaryValue = env[primary];
  if (primaryValue !== undefined && primaryValue !== '') return primaryValue;
  const legacyValue = env[legacy];
  if (legacyValue !== undefined && legacyValue !== '') {
    if (!warned.envFallback) {
      warned.envFallback = true;
      warn.write(
        `[owlette] ${legacy} is deprecated; use ${primary} instead. ` +
          `legacy env vars will be removed on ${LEGACY_REMOVAL_DATE}.\n`,
      );
    }
    return legacyValue;
  }
  return undefined;
}

/**
 * If the new config path doesn't exist but the legacy ~/.config/roost/
 * one does, copy it once and emit a migration notice. Returns the path
 * that should be read (which may be either the new or — if the migration
 * couldn't run, e.g. permission errors — the legacy path).
 */
function migrateLegacyConfigOnce(
  configPath: string,
  legacyPath: string,
  warn: { write(s: string): unknown },
): string {
  if (existsSync(configPath)) return configPath;
  if (!existsSync(legacyPath)) return configPath;

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    copyFileSync(legacyPath, configPath);
    if (!warned.configMigrated) {
      warned.configMigrated = true;
      warn.write(
        `[owlette] migrated config from ${legacyPath} → ${configPath}. ` +
          `the old location still works for one release cycle but is deprecated; ` +
          `it will be removed on ${LEGACY_REMOVAL_DATE}.\n`,
      );
    }
    return configPath;
  } catch {
    // Migration is best-effort. If the copy fails (read-only fs, permission
    // problems), fall back to reading the legacy file in place so the user
    // doesn't lose their auth state mid-rename.
    return legacyPath;
  }
}

export function loadConfig(opts: LoadConfigOpts = {}): OwletteConfig {
  const env = opts.env ?? process.env;
  const warn = opts.warnStream ?? process.stderr;
  const profileEnv = readEnvWithLegacyFallback(env, warn, 'OWLETTE_PROFILE', 'ROOST_PROFILE');
  const profile = opts.profile ?? profileEnv ?? 'default';

  const requestedConfigPath = opts.configPath ?? defaultConfigPath();
  const requestedCredentialPath = opts.credentialPath ?? defaultCredentialPath(requestedConfigPath);
  const legacyPath = opts.legacyConfigPath ?? legacyConfigPath();
  const configPath = migrateLegacyConfigOnce(requestedConfigPath, legacyPath, warn);

  const tokenEnv = readEnvWithLegacyFallback(env, warn, 'OWLETTE_TOKEN', 'ROOST_TOKEN');
  const apiUrlEnv = readEnvWithLegacyFallback(env, warn, 'OWLETTE_API_URL', 'ROOST_API_URL');
  const envEnv = readEnvWithLegacyFallback(env, warn, 'OWLETTE_ENVIRONMENT', 'ROOST_ENVIRONMENT');

  const cacheKey =
    `${configPath}::${requestedCredentialPath}::${profile}::` +
    `${opts.credentialBackend ?? env.OWLETTE_CREDENTIAL_BACKEND ?? ''}::` +
    `${tokenEnv ?? ''}::${apiUrlEnv ?? ''}::${envEnv ?? ''}`;
  if (!opts.reload && cache?.key === cacheKey) return cache.config;

  let fileToken: string | null = null;
  let fileApiUrl: string | null = null;
  let fileEnv: 'live' | 'test' | null = null;
  let resolvedConfigPath: string | null = null;

  if (existsSync(configPath)) {
    resolvedConfigPath = configPath;
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseToml(raw) as Record<string, unknown>;

    const topApiUrl = typeof parsed.api_url === 'string' ? parsed.api_url : null;
    const topEnv = parseEnv(parsed.environment);

    const profiles = parsed.profiles;
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
      const selected = (profiles as Record<string, unknown>)[profile];
      if (selected && typeof selected === 'object' && !Array.isArray(selected)) {
        const s = selected as Record<string, unknown>;
        if (typeof s.token === 'string') fileToken = s.token;
        if (typeof s.api_url === 'string') fileApiUrl = s.api_url;
        const pEnv = parseEnv(s.environment);
        if (pEnv) fileEnv = pEnv;
      }
    }

    if (fileApiUrl === null && topApiUrl !== null) fileApiUrl = topApiUrl;
    if (fileEnv === null && topEnv !== null) fileEnv = topEnv;
  }

  const shouldReadStoredCredential =
    !(env.NODE_ENV === 'test' && !opts.configPath && !opts.credentialPath && !opts.credentialBackend);
  const storedCredential = shouldReadStoredCredential
    ? readStoredCredential({
        profile,
        credentialPath: requestedCredentialPath,
        backend: opts.credentialBackend,
        env,
      })
    : null;

  const token = tokenEnv ?? storedCredential?.token ?? fileToken;
  const apiUrl = apiUrlEnv ?? fileApiUrl ?? storedCredential?.apiUrl ?? DEFAULT_API_URL;
  const environment = parseEnv(envEnv) ?? fileEnv ?? storedCredential?.environment ?? null;
  const credentialSource = tokenEnv
    ? 'env'
    : storedCredential
      ? storedCredential.source
      : fileToken
        ? 'config'
        : null;

  const config: OwletteConfig = {
    token,
    apiUrl,
    environment,
    profile,
    configPath: resolvedConfigPath,
    credentialPath: storedCredential?.credentialPath ?? null,
    credentialSource,
  };

  cache = { config, key: cacheKey };
  return config;
}

function parseEnv(v: unknown): 'live' | 'test' | null {
  if (v === 'live' || v === 'test') return v;
  return null;
}

/** Reset the module-level config cache. Primarily for tests. */
export function _resetConfigCache(): void {
  cache = null;
}

/**
 * Reset the once-per-process deprecation flags. Tests use this to assert
 * the warning is emitted on first read but not on subsequent reads.
 */
export function _resetDeprecationWarnings(): void {
  warned.envFallback = false;
  warned.configMigrated = false;
}
