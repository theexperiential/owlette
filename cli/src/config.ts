/**
 * Config loader for the roost CLI.
 *
 * Resolution order (first-wins for each field):
 *   1. Environment: ROOST_TOKEN, ROOST_API_URL, ROOST_ENVIRONMENT
 *   2. Profile in ~/.config/roost/config.toml (default profile: `default`)
 *   3. Built-in defaults (ROOST_API_URL → https://owlette.app)
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
 * The active profile is chosen by ROOST_PROFILE env var or --profile CLI
 * flag; default is 'default'.
 *
 * The config file is read lazily on first `loadConfig()` call and cached.
 * Tests pass `opts.now` to reset the cache via `loadConfig({ reload: true })`.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as parseToml } from 'smol-toml';

export const DEFAULT_API_URL = 'https://owlette.app';

export interface RoostConfig {
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
}

export interface LoadConfigOpts {
  /** Override ~/.config/roost/config.toml lookup (used in tests). */
  configPath?: string;
  /** Force re-read (bypasses the module-level cache). */
  reload?: boolean;
  /** Active profile name; defaults to $ROOST_PROFILE or 'default'. */
  profile?: string;
  /** Read-env overrides (default: process.env). Used for test isolation. */
  env?: NodeJS.ProcessEnv;
}

let cache: { config: RoostConfig; key: string } | null = null;

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'roost', 'config.toml');
}

export function loadConfig(opts: LoadConfigOpts = {}): RoostConfig {
  const env = opts.env ?? process.env;
  const profile = opts.profile ?? env.ROOST_PROFILE ?? 'default';
  const configPath = opts.configPath ?? defaultConfigPath();
  const cacheKey = `${configPath}::${profile}::${env.ROOST_TOKEN ?? ''}::${env.ROOST_API_URL ?? ''}::${env.ROOST_ENVIRONMENT ?? ''}`;

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

    // Fall back to top-level values when the profile doesn't override.
    if (fileApiUrl === null && topApiUrl !== null) fileApiUrl = topApiUrl;
    if (fileEnv === null && topEnv !== null) fileEnv = topEnv;
  }

  const token =
    env.ROOST_TOKEN && env.ROOST_TOKEN.length > 0 ? env.ROOST_TOKEN : fileToken;
  const apiUrl =
    (env.ROOST_API_URL && env.ROOST_API_URL.length > 0
      ? env.ROOST_API_URL
      : fileApiUrl) ?? DEFAULT_API_URL;
  const environment = parseEnv(env.ROOST_ENVIRONMENT) ?? fileEnv;

  const config: RoostConfig = {
    token,
    apiUrl,
    environment,
    profile,
    configPath: resolvedConfigPath,
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
