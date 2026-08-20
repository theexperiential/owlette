/**
 * Minimal writer for ~/.config/owlette/config.toml. smol-toml parses; serialisation is hand
 * rolled (it exports no writer) and covers only top-level string keys and
 * [profiles.<name>] string tables.
 *
 * Consequence: hand-written richer TOML (inline tables, arrays of tables) and all comments
 * are DROPPED on rewrite — documented in the cli README. Unrelated profiles survive because
 * the existing file is read back first.
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

  // Alphabetical for determinism, 'default' first.
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

  // writeFileSync's mode applies to fresh files only, not overwrites.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod is best-effort on Windows */
  }
}

/** Non-secret profile metadata; `auth login` keeps the raw token in the credential store. */
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
 * Write the token (+ optional api_url / environment) into config.toml, creating parent dirs;
 * returns the path. Legacy tests / migration only — new login code uses credentialStore.ts.
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

/** Drop the profile's token, leaving api_url/environment. True when one was actually cleared. */
export function clearTokenFromConfig(opts: ClearTokenOpts): boolean {
  const config = loadOrInit(opts.configPath);
  const profile = config.profiles?.[opts.profile];
  if (!profile || typeof profile.token !== 'string') return false;

  delete profile.token;
  writeConfigFile(opts.configPath, config);
  return true;
}
