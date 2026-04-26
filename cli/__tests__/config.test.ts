import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_API_URL,
  _resetConfigCache,
  _resetDeprecationWarnings,
  loadConfig,
} from '../src/config';

function withConfigFile(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlette-cli-config-'));
  const path = join(dir, 'config.toml');
  writeFileSync(path, toml, 'utf-8');
  return path;
}

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'owlette-cli-config-'));
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

describe('loadConfig', () => {
  it('returns built-in defaults when no config + no env', () => {
    const config = loadConfig({
      configPath: '/nonexistent/owlette/config.toml',
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: {},
      reload: true,
    });
    expect(config.token).toBeNull();
    expect(config.apiUrl).toBe(DEFAULT_API_URL);
    expect(config.environment).toBeNull();
    expect(config.profile).toBe('default');
    expect(config.configPath).toBeNull();
  });

  it('reads token + api_url + environment from the default profile', () => {
    const path = withConfigFile(`
[profiles.default]
token = "owk_live_abc"
api_url = "https://owlette.app"
environment = "live"
`);
    const config = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: {},
      reload: true,
    });
    expect(config.token).toBe('owk_live_abc');
    expect(config.apiUrl).toBe('https://owlette.app');
    expect(config.environment).toBe('live');
    expect(config.configPath).toBe(path);
  });

  it('picks the named profile when --profile is supplied', () => {
    const path = withConfigFile(`
[profiles.default]
token = "owk_live_default"

[profiles.dev]
token = "owk_test_dev"
api_url = "https://dev.owlette.app"
environment = "test"
`);
    const config = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: {},
      profile: 'dev',
      reload: true,
    });
    expect(config.token).toBe('owk_test_dev');
    expect(config.apiUrl).toBe('https://dev.owlette.app');
    expect(config.environment).toBe('test');
    expect(config.profile).toBe('dev');
  });

  it('falls back to top-level api_url + environment when profile omits them', () => {
    const path = withConfigFile(`
api_url = "https://top-level.example"
environment = "live"

[profiles.default]
token = "owk_live_x"
`);
    const config = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: {},
      reload: true,
    });
    expect(config.apiUrl).toBe('https://top-level.example');
    expect(config.environment).toBe('live');
  });

  it('OWLETTE_TOKEN env overrides the config file', () => {
    const path = withConfigFile(`
[profiles.default]
token = "owk_live_fromfile"
`);
    const config = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: { OWLETTE_TOKEN: 'owk_live_fromenv' },
      reload: true,
    });
    expect(config.token).toBe('owk_live_fromenv');
  });

  it('OWLETTE_API_URL env overrides profile api_url', () => {
    const path = withConfigFile(`
[profiles.default]
api_url = "https://owlette.app"
`);
    const config = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: { OWLETTE_API_URL: 'https://custom.example' },
      reload: true,
    });
    expect(config.apiUrl).toBe('https://custom.example');
  });

  it('OWLETTE_PROFILE env picks profile when no explicit --profile', () => {
    const path = withConfigFile(`
[profiles.dev]
token = "owk_test_devprofile"
`);
    const config = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: { OWLETTE_PROFILE: 'dev' },
      reload: true,
    });
    expect(config.token).toBe('owk_test_devprofile');
    expect(config.profile).toBe('dev');
  });

  it('ignores invalid environment values silently', () => {
    const path = withConfigFile(`
environment = "prod"

[profiles.default]
environment = "staging"
`);
    const config = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: {},
      reload: true,
    });
    expect(config.environment).toBeNull();
  });
});

describe('legacy fallback (ROOST_*)', () => {
  it('ROOST_TOKEN still works as a fallback when OWLETTE_TOKEN is unset, with a one-time deprecation warning', () => {
    const path = withConfigFile(`
[profiles.default]
token = "owk_live_fromfile"
`);
    const warn = makeWarnSink();

    const first = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: { ROOST_TOKEN: 'owk_live_fromlegacyenv' },
      warnStream: warn,
      reload: true,
    });
    expect(first.token).toBe('owk_live_fromlegacyenv');
    expect(warn.writes.join('')).toContain('ROOST_TOKEN is deprecated');

    // Second call should not re-emit the warning (once per process).
    _resetConfigCache();
    const second = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: { ROOST_TOKEN: 'owk_live_fromlegacyenv' },
      warnStream: warn,
      reload: true,
    });
    expect(second.token).toBe('owk_live_fromlegacyenv');
    const deprecationLines = warn.writes.filter((s) => s.includes('ROOST_TOKEN is deprecated'));
    expect(deprecationLines).toHaveLength(1);
  });

  it('OWLETTE_TOKEN takes precedence over ROOST_TOKEN when both are set', () => {
    const path = withConfigFile(`
[profiles.default]
token = "owk_live_fromfile"
`);
    const warn = makeWarnSink();
    const config = loadConfig({
      configPath: path,
      legacyConfigPath: '/nonexistent/roost/config.toml',
      env: {
        OWLETTE_TOKEN: 'owk_live_primary',
        ROOST_TOKEN: 'owk_live_legacy',
      },
      warnStream: warn,
      reload: true,
    });
    expect(config.token).toBe('owk_live_primary');
    // Since OWLETTE_TOKEN was set, the legacy var was never read — no warning.
    expect(warn.writes.join('')).not.toContain('ROOST_TOKEN is deprecated');
  });
});

describe('legacy config-path migration (~/.config/roost → ~/.config/owlette)', () => {
  it('copies the legacy file to the new path on first read and emits a one-time migration notice', () => {
    const dir = freshTmpDir();
    const newPath = join(dir, 'owlette', 'config.toml');
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
    expect(warn.writes.join('')).toContain('migrated config from');
  });

  it('does not migrate when the new path already exists (new wins)', () => {
    const dir = freshTmpDir();
    const newPath = join(dir, 'owlette', 'config.toml');
    require('fs').mkdirSync(join(dir, 'owlette'), { recursive: true });
    writeFileSync(
      newPath,
      `
[profiles.default]
token = "owk_live_new"
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
`,
      'utf-8',
    );
    const warn = makeWarnSink();

    const config = loadConfig({
      configPath: newPath,
      legacyConfigPath: legacyPath,
      env: {},
      warnStream: warn,
      reload: true,
    });

    expect(config.token).toBe('owk_live_new');
    expect(warn.writes.join('')).not.toContain('migrated config');
  });
});
