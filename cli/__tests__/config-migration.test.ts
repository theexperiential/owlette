/**
 * End-to-end tests for the legacy → owlette migration paths covered by
 * `loadConfig`. The four scenarios from wave-1 tasks 1.4 + 1.5 (and the
 * wave-4 4.3 spec):
 *
 *   1. ROOST_* env var works as a fallback with a one-time deprecation
 *      warning per process.
 *   2. OWLETTE_* + ROOST_* both set → OWLETTE_* wins and the legacy var
 *      is NEVER consulted (so no deprecation warning emitted).
 *   3. Legacy ~/.config/roost/config.toml is copied to ~/.config/owlette/
 *      on first read with a one-time migration notice.
 *   4. Both config paths exist → new path is used and the migration
 *      notice is NOT re-emitted (the migration is a one-shot operation).
 *
 * Each test uses `mkdtempSync` for hermetic tmpfiles and an explicit
 * `env` + `warnStream` override on `loadConfig` so the host machine's
 * real ~/.config/ and process.env never leak in.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  _resetConfigCache,
  _resetDeprecationWarnings,
  loadConfig,
} from '../src/config';

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'owlette-cli-migrate-'));
}

function makeWarnSink(): { writes: string[]; write(s: string): true } {
  const writes: string[] = [];
  return {
    writes,
    write(s: string) {
      writes.push(s);
      return true;
    },
  };
}

beforeEach(() => {
  _resetConfigCache();
  _resetDeprecationWarnings();
});

describe('scenario 1: ROOST_* env vars work with a one-time deprecation warning', () => {
  it('reads ROOST_TOKEN when OWLETTE_TOKEN is unset and emits the deprecation line', () => {
    const warn = makeWarnSink();
    const config = loadConfig({
      configPath: '/nonexistent/owlette/config.toml',
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: { ROOST_TOKEN: 'owk_live_legacy' },
      warnStream: warn,
      reload: true,
    });

    expect(config.token).toBe('owk_live_legacy');
    const joined = warn.writes.join('');
    expect(joined).toContain('ROOST_TOKEN is deprecated');
    expect(joined).toContain('OWLETTE_TOKEN');
    expect(joined).toContain('2026-10-01');
  });

  it('only warns once per process across multiple loadConfig calls', () => {
    const warn = makeWarnSink();
    const opts = {
      configPath: '/nonexistent/owlette/config.toml',
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: { ROOST_TOKEN: 'owk_live_legacy' },
      warnStream: warn,
      reload: true,
    };
    loadConfig(opts);
    _resetConfigCache();
    loadConfig(opts);
    _resetConfigCache();
    loadConfig(opts);

    const lines = warn.writes.filter((s) => s.includes('ROOST_TOKEN is deprecated'));
    expect(lines).toHaveLength(1);
  });
});

describe('scenario 2: OWLETTE_* + ROOST_* both set', () => {
  it('OWLETTE_TOKEN wins and the legacy var is never read (no deprecation warning)', () => {
    const warn = makeWarnSink();
    const config = loadConfig({
      configPath: '/nonexistent/owlette/config.toml',
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: {
        OWLETTE_TOKEN: 'owk_live_primary',
        ROOST_TOKEN: 'owk_live_legacy',
      },
      warnStream: warn,
      reload: true,
    });

    expect(config.token).toBe('owk_live_primary');
    expect(warn.writes.join('')).not.toContain('ROOST_TOKEN is deprecated');
  });

  it('OWLETTE_API_URL wins over ROOST_API_URL with no warning', () => {
    const warn = makeWarnSink();
    const config = loadConfig({
      configPath: '/nonexistent/owlette/config.toml',
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: {
        OWLETTE_API_URL: 'https://primary.example',
        ROOST_API_URL: 'https://legacy.example',
      },
      warnStream: warn,
      reload: true,
    });

    expect(config.apiUrl).toBe('https://primary.example');
    expect(warn.writes.join('')).not.toContain('deprecated');
  });
});

describe('scenario 3: legacy ~/.config/roost/config.toml is copied on first read', () => {
  it('migrates the legacy file to the new path and emits the migration notice once', () => {
    const newDir = freshTmpDir();
    const newPath = join(newDir, 'owlette', 'config.toml');
    const legacyDir = freshTmpDir();
    const legacyPath = join(legacyDir, 'config.toml');
    writeFileSync(
      legacyPath,
      `
[profiles.default]
token = "owk_live_legacy"
api_url = "https://legacy.example"
environment = "live"
`,
      'utf-8',
    );
    const warn = makeWarnSink();

    expect(existsSync(newPath)).toBe(false);

    const config = loadConfig({
      configPath: newPath,
      legacyConfigPath: legacyPath,
      env: {},
      warnStream: warn,
      reload: true,
    });

    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, 'utf-8')).toBe(readFileSync(legacyPath, 'utf-8'));
    expect(config.token).toBe('owk_live_legacy');
    expect(config.apiUrl).toBe('https://legacy.example');
    expect(config.environment).toBe('live');
    expect(config.configPath).toBe(newPath);

    const joined = warn.writes.join('');
    expect(joined).toContain('migrated config from');
    expect(joined).toContain(legacyPath);
    expect(joined).toContain(newPath);
    expect(joined).toContain('2026-10-01');
  });

  it('only emits the migration notice once even if loadConfig is called repeatedly', () => {
    const newDir = freshTmpDir();
    const newPath = join(newDir, 'owlette', 'config.toml');
    const legacyDir = freshTmpDir();
    const legacyPath = join(legacyDir, 'config.toml');
    writeFileSync(
      legacyPath,
      `
[profiles.default]
token = "owk_live_legacy"
`,
      'utf-8',
    );
    const warn = makeWarnSink();

    loadConfig({
      configPath: newPath,
      legacyConfigPath: legacyPath,
      env: {},
      warnStream: warn,
      reload: true,
    });
    _resetConfigCache();
    loadConfig({
      configPath: newPath,
      legacyConfigPath: legacyPath,
      env: {},
      warnStream: warn,
      reload: true,
    });

    const lines = warn.writes.filter((s) => s.includes('migrated config from'));
    expect(lines).toHaveLength(1);
  });
});

describe('scenario 4: both config paths exist → new path is used', () => {
  it('reads the new path and does NOT re-copy + does NOT re-emit the migration notice', () => {
    const newDir = freshTmpDir();
    const newPath = join(newDir, 'owlette', 'config.toml');
    mkdirSync(join(newDir, 'owlette'), { recursive: true });
    writeFileSync(
      newPath,
      `
[profiles.default]
token = "owk_live_new"
api_url = "https://new.example"
`,
      'utf-8',
    );
    const legacyDir = freshTmpDir();
    const legacyPath = join(legacyDir, 'config.toml');
    writeFileSync(
      legacyPath,
      `
[profiles.default]
token = "owk_live_legacy"
api_url = "https://legacy.example"
`,
      'utf-8',
    );
    const newPathContentBefore = readFileSync(newPath, 'utf-8');
    const warn = makeWarnSink();

    const config = loadConfig({
      configPath: newPath,
      legacyConfigPath: legacyPath,
      env: {},
      warnStream: warn,
      reload: true,
    });

    expect(config.token).toBe('owk_live_new');
    expect(config.apiUrl).toBe('https://new.example');
    expect(config.configPath).toBe(newPath);
    // New file content must be untouched (no overwrite from legacy).
    expect(readFileSync(newPath, 'utf-8')).toBe(newPathContentBefore);
    expect(warn.writes.join('')).not.toContain('migrated config');
  });
});
