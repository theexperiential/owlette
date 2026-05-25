/**
 * Minimal writer for ~/.config/owlette/config.toml.
 *
 * Parses with smol-toml, mutates the in-memory JS object, then serialises
 * by hand — smol-toml only exports a parser today, so we write a narrow
 * custom serialiser that covers the two cases we actually use:
 *   - top-level string keys (api_url, environment)
 *   - [profiles.<name>] tables with string keys (token, api_url, environment)
 *
 * If a user hand-edits the file with richer TOML (inline tables, arrays of
 * tables, etc.) our rewrite will drop those. We read the existing file so
 * unrelated profiles survive, then write the full object back. TOML
 * comments are NOT preserved — documented in the cli README.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { parse as parseToml } from 'smol-toml';

export interface WriteTokenOpts {
  configPath: string;
  profile: string;
  token: string;
  apiUrl?: string;
  environment?: 'live' | 'test';
}

export interface ClearTokenOpts {
  configPath: string;
  profile: string;
}

export interface WriteProfileConfigOpts {
  configPath: string;
  profile: string;
  apiUrl?: string;
  environment?: 'live' | 'test';
}

interface ProfileTable {
  token?: string;
  api_url?: string;
  environment?: 'live' | 'test';
  [k: string]: unknown;
}

interface ConfigFile {
  api_url?: string;
  environment?: 'live' | 'test';
  profiles?: Record<string, ProfileTable>;
  [k: string]: unknown;
}

function loadOrInit(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    return parseToml(raw) as ConfigFile;
  } catch {
    return {};
  }
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function serialise(config: ConfigFile): string {
  const lines: string[] = [];

  // Top-level scalars first.
  for (const [key, value] of Object.entries(config)) {
    if (key === 'profiles') continue;
    if (typeof value === 'string') {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  if (lines.length > 0) lines.push('');

  // Profiles sorted alphabetically for determinism; put 'default' first.
  const profiles = config.profiles ?? {};
  const profileNames = Object.keys(profiles).sort((a, b) => {
    if (a === 'default' && b !== 'default') return -1;
    if (b === 'default' && a !== 'default') return 1;
    return a.localeCompare(b);
  });

  for (const name of profileNames) {
    const profile = profiles[name];
    if (!profile) continue;
    lines.push(`[profiles.${tomlKeySegment(name)}]`);
    for (const [key, value] of Object.entries(profile)) {
      if (typeof value === 'string') {
        lines.push(`${key} = ${tomlString(value)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

function writeConfigFile(path: string, config: ConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialise(config), { encoding: 'utf-8', mode: 0o600 });

  // Belt + suspenders on the file permissions — writeFileSync's mode is
  // honored on fresh files but not on overwrites of existing ones.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod is best-effort on Windows */
  }
}

/**
 * Write non-secret profile metadata. New `auth login` calls use this for
 * api_url / environment while storing the raw token in the credential store.
 */
export function writeProfileConfig(opts: WriteProfileConfigOpts): string {
  const config = loadOrInit(opts.configPath);
  config.profiles ??= {};
  const existing = config.profiles[opts.profile] ?? {};
  const next: ProfileTable = { ...existing };
  if (opts.apiUrl) next.api_url = opts.apiUrl;
  if (opts.environment) next.environment = opts.environment;
  config.profiles[opts.profile] = next;

  writeConfigFile(opts.configPath, config);
  return opts.configPath;
}

/**
 * Write the token (+ optional api_url / environment) to the named profile
 * in config.toml. Creates parent dirs as needed. Returns the written path.
 * Kept for legacy tests/migration paths; new login code stores tokens with
 * credentialStore.ts instead.
 */
export function writeTokenToConfig(opts: WriteTokenOpts): string {
  const config = loadOrInit(opts.configPath);

  config.profiles ??= {};
  const existing = config.profiles[opts.profile] ?? {};
  const next: ProfileTable = {
    ...existing,
    token: opts.token,
  };
  if (opts.apiUrl) next.api_url = opts.apiUrl;
  if (opts.environment) next.environment = opts.environment;
  config.profiles[opts.profile] = next;

  writeConfigFile(opts.configPath, config);
  return opts.configPath;
}

/**
 * Remove the token field from the named profile. Leaves other profile
 * values (api_url, environment) in place. Returns true if a token was
 * actually cleared.
 */
export function clearTokenFromConfig(opts: ClearTokenOpts): boolean {
  const config = loadOrInit(opts.configPath);
  const profile = config.profiles?.[opts.profile];
  if (!profile || typeof profile.token !== 'string') return false;

  delete profile.token;
  writeConfigFile(opts.configPath, config);
  return true;
}
