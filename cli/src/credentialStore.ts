import { execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { homedir, platform } from 'os';

const KEYCHAIN_SERVICE = 'owlette-cli';

export type CredentialBackend = 'auto' | 'keychain' | 'token-file';
export type StoredCredentialSource = 'keychain' | 'token-file';

export interface StoredCredential {
  token: string;
  apiUrl?: string;
  environment?: 'live' | 'test';
  updatedAt?: string;
}

export interface CredentialReadResult extends StoredCredential {
  source: StoredCredentialSource;
  credentialPath: string | null;
}

export interface WriteStoredCredentialOpts extends StoredCredential {
  profile: string;
  credentialPath?: string | undefined;
  backend?: CredentialBackend | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ReadStoredCredentialOpts {
  profile: string;
  credentialPath?: string | undefined;
  backend?: CredentialBackend | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ClearStoredCredentialOpts {
  profile: string;
  credentialPath?: string | undefined;
  backend?: CredentialBackend | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

interface CredentialFileEntry {
  token?: unknown;
  api_url?: unknown;
  environment?: unknown;
  updated_at?: unknown;
}

interface CredentialFile {
  version?: unknown;
  profiles?: Record<string, CredentialFileEntry>;
}

export interface WriteCredentialResult {
  source: StoredCredentialSource;
  credentialPath: string | null;
}

function defaultOwletteConfigPath(): string {
  return join(homedir(), '.config', 'owlette', 'config.toml');
}

export function defaultCredentialPath(configPath = defaultOwletteConfigPath()): string {
  return join(dirname(configPath), 'credentials.json');
}

export function resolveCredentialBackend(
  backend: CredentialBackend | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CredentialBackend {
  const fromEnv = env.OWLETTE_CREDENTIAL_BACKEND;
  if (fromEnv === 'keychain' || fromEnv === 'token-file' || fromEnv === 'auto') {
    return fromEnv;
  }
  return backend ?? 'auto';
}

export function readStoredCredential(
  opts: ReadStoredCredentialOpts,
): CredentialReadResult | null {
  const credentialPath = opts.credentialPath ?? defaultCredentialPath();
  const backend = resolveCredentialBackend(opts.backend, opts.env);

  if (shouldUseKeychain(backend, opts.env)) {
    const credential = readKeychainCredential(opts.profile);
    if (credential) {
      return {
        ...credential,
        source: 'keychain',
        credentialPath: null,
      };
    }
  }

  const credential = readTokenFileCredential(credentialPath, opts.profile);
  if (!credential) return null;
  return {
    ...credential,
    source: 'token-file',
    credentialPath,
  };
}

export function writeStoredCredential(
  opts: WriteStoredCredentialOpts,
): WriteCredentialResult {
  const credentialPath = opts.credentialPath ?? defaultCredentialPath();
  const backend = resolveCredentialBackend(opts.backend, opts.env);
  const credential = normalizeCredential(opts);

  if (shouldUseKeychain(backend, opts.env)) {
    try {
      writeKeychainCredential(opts.profile, credential);
      return { source: 'keychain', credentialPath: null };
    } catch {
      if (backend === 'keychain') throw new Error('failed to write credential to OS keychain');
    }
  }

  writeTokenFileCredential(credentialPath, opts.profile, credential);
  return { source: 'token-file', credentialPath };
}

export function clearStoredCredential(opts: ClearStoredCredentialOpts): boolean {
  const credentialPath = opts.credentialPath ?? defaultCredentialPath();
  const backend = resolveCredentialBackend(opts.backend, opts.env);
  let cleared = false;

  if (shouldUseKeychain(backend, opts.env)) {
    cleared = clearKeychainCredential(opts.profile) || cleared;
  }

  cleared = clearTokenFileCredential(credentialPath, opts.profile) || cleared;
  return cleared;
}

function shouldUseKeychain(
  backend: CredentialBackend,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (backend === 'token-file') return false;
  if (env.NODE_ENV === 'test' && backend !== 'keychain') return false;
  const p = platform();
  return p === 'darwin' || p === 'linux';
}

function normalizeCredential(input: StoredCredential): StoredCredential {
  const credential: StoredCredential = {
    token: input.token,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  if (input.apiUrl) credential.apiUrl = input.apiUrl;
  if (input.environment) credential.environment = input.environment;
  return credential;
}

function parseCredentialPayload(raw: string): StoredCredential | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('owk_')) return { token: trimmed };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.token !== 'string' || record.token.length === 0) return null;

  const credential: StoredCredential = { token: record.token };
  const apiUrl = typeof record.api_url === 'string' ? record.api_url : record.apiUrl;
  if (typeof apiUrl === 'string' && apiUrl.length > 0) credential.apiUrl = apiUrl;
  if (record.environment === 'live' || record.environment === 'test') {
    credential.environment = record.environment;
  }
  const updatedAt =
    typeof record.updated_at === 'string' ? record.updated_at : record.updatedAt;
  if (typeof updatedAt === 'string' && updatedAt.length > 0) {
    credential.updatedAt = updatedAt;
  }
  return credential;
}

function serializeCredentialPayload(credential: StoredCredential): string {
  const payload: Record<string, string> = { token: credential.token };
  if (credential.apiUrl) payload.api_url = credential.apiUrl;
  if (credential.environment) payload.environment = credential.environment;
  if (credential.updatedAt) payload.updated_at = credential.updatedAt;
  return JSON.stringify(payload);
}

function loadCredentialFile(path: string): CredentialFile {
  if (!existsSync(path)) return { version: 1, profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CredentialFile;
    if (!parsed || typeof parsed !== 'object') return { version: 1, profiles: {} };
    if (!parsed.profiles || typeof parsed.profiles !== 'object') parsed.profiles = {};
    return parsed;
  } catch {
    return { version: 1, profiles: {} };
  }
}

function readTokenFileCredential(path: string, profile: string): StoredCredential | null {
  const file = loadCredentialFile(path);
  const entry = file.profiles?.[profile];
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.token !== 'string' || entry.token.length === 0) return null;

  const credential: StoredCredential = { token: entry.token };
  if (typeof entry.api_url === 'string' && entry.api_url.length > 0) {
    credential.apiUrl = entry.api_url;
  }
  if (entry.environment === 'live' || entry.environment === 'test') {
    credential.environment = entry.environment;
  }
  if (typeof entry.updated_at === 'string' && entry.updated_at.length > 0) {
    credential.updatedAt = entry.updated_at;
  }
  return credential;
}

function writeTokenFileCredential(
  path: string,
  profile: string,
  credential: StoredCredential,
): void {
  const file = loadCredentialFile(path);
  file.version = 1;
  file.profiles ??= {};
  const entry: CredentialFileEntry = { token: credential.token };
  if (credential.apiUrl) entry.api_url = credential.apiUrl;
  if (credential.environment) entry.environment = credential.environment;
  if (credential.updatedAt) entry.updated_at = credential.updatedAt;
  file.profiles[profile] = entry;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  chmodBestEffort(path);
}

function clearTokenFileCredential(path: string, profile: string): boolean {
  if (!existsSync(path)) return false;
  const file = loadCredentialFile(path);
  const existing = file.profiles?.[profile];
  if (!existing || typeof existing.token !== 'string') return false;
  delete file.profiles?.[profile];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  chmodBestEffort(path);
  return true;
}

function chmodBestEffort(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod is best-effort on Windows */
  }
}

function readKeychainCredential(profile: string): StoredCredential | null {
  try {
    if (platform() === 'darwin') {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-a', profile, '-s', KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return parseCredentialPayload(raw);
    }

    if (platform() === 'linux') {
      const raw = execFileSync(
        'secret-tool',
        ['lookup', 'service', KEYCHAIN_SERVICE, 'profile', profile],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return parseCredentialPayload(raw);
    }
  } catch {
    return null;
  }
  return null;
}

function writeKeychainCredential(profile: string, credential: StoredCredential): void {
  const payload = serializeCredentialPayload(credential);
  if (platform() === 'darwin') {
    execFileSync(
      'security',
      ['add-generic-password', '-a', profile, '-s', KEYCHAIN_SERVICE, '-w', payload, '-U'],
      { stdio: 'ignore' },
    );
    return;
  }

  if (platform() === 'linux') {
    execFileSync(
      'secret-tool',
      ['store', '--label=Owlette CLI', 'service', KEYCHAIN_SERVICE, 'profile', profile],
      { input: payload, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    return;
  }

  throw new Error('OS keychain is not available on this platform');
}

function clearKeychainCredential(profile: string): boolean {
  try {
    if (platform() === 'darwin') {
      execFileSync(
        'security',
        ['delete-generic-password', '-a', profile, '-s', KEYCHAIN_SERVICE],
        { stdio: 'ignore' },
      );
      return true;
    }

    if (platform() === 'linux') {
      execFileSync(
        'secret-tool',
        ['clear', 'service', KEYCHAIN_SERVICE, 'profile', profile],
        { stdio: 'ignore' },
      );
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
