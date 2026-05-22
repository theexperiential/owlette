import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseToml } from 'smol-toml';
import {
  writeTokenToConfig,
  clearTokenFromConfig,
  writeProfileConfig,
} from '../src/configWriter';

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlette-cli-writer-'));
  return join(dir, 'config.toml');
}

describe('writeTokenToConfig', () => {
  it('creates the file + writes the token in the default profile', () => {
    const path = tmpPath();
    expect(existsSync(path)).toBe(false);

    writeTokenToConfig({
      configPath: path,
      profile: 'default',
      token: 'owk_live_abc',
    });

    expect(existsSync(path)).toBe(true);
    const parsed = parseToml(readFileSync(path, 'utf-8')) as {
      profiles?: Record<string, { token?: string }>;
    };
    expect(parsed.profiles?.default?.token).toBe('owk_live_abc');
  });

  it('preserves other profiles when writing one', () => {
    const path = tmpPath();
    writeFileSync(
      path,
      `[profiles.other]
token = "owk_test_other"
api_url = "https://dev.owlette.app"
`,
    );

    writeTokenToConfig({
      configPath: path,
      profile: 'default',
      token: 'owk_live_new',
      apiUrl: 'https://owlette.app',
      environment: 'live',
    });

    const parsed = parseToml(readFileSync(path, 'utf-8')) as {
      profiles?: Record<string, { token?: string; api_url?: string; environment?: string }>;
    };
    expect(parsed.profiles?.other?.token).toBe('owk_test_other');
    expect(parsed.profiles?.other?.api_url).toBe('https://dev.owlette.app');
    expect(parsed.profiles?.default?.token).toBe('owk_live_new');
    expect(parsed.profiles?.default?.api_url).toBe('https://owlette.app');
    expect(parsed.profiles?.default?.environment).toBe('live');
  });

  it('round-trips through parser (valid TOML output)', () => {
    const path = tmpPath();
    writeTokenToConfig({
      configPath: path,
      profile: 'default',
      token: 'owk_live_x"y\\z',
      apiUrl: 'https://owlette.app',
      environment: 'live',
    });
    const raw = readFileSync(path, 'utf-8');
    expect(() => parseToml(raw)).not.toThrow();
    const parsed = parseToml(raw) as { profiles?: Record<string, { token?: string }> };
    expect(parsed.profiles?.default?.token).toBe('owk_live_x"y\\z');
  });

  it('quotes profile table names that are not bare TOML keys', () => {
    const path = tmpPath();
    writeTokenToConfig({
      configPath: path,
      profile: 'release candidate.1',
      token: 'owk_live_spacey',
    });

    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('[profiles."release candidate.1"]');
    const parsed = parseToml(raw) as { profiles?: Record<string, { token?: string }> };
    expect(parsed.profiles?.['release candidate.1']?.token).toBe('owk_live_spacey');
  });
});

describe('clearTokenFromConfig', () => {
  it('returns false when no token existed', () => {
    const path = tmpPath();
    const cleared = clearTokenFromConfig({ configPath: path, profile: 'default' });
    expect(cleared).toBe(false);
  });

  it('removes only the token, leaves other profile fields', () => {
    const path = tmpPath();
    writeTokenToConfig({
      configPath: path,
      profile: 'default',
      token: 'owk_live_abc',
      apiUrl: 'https://owlette.app',
      environment: 'live',
    });

    const cleared = clearTokenFromConfig({ configPath: path, profile: 'default' });
    expect(cleared).toBe(true);

    const parsed = parseToml(readFileSync(path, 'utf-8')) as {
      profiles?: Record<string, { token?: string; api_url?: string }>;
    };
    expect(parsed.profiles?.default?.token).toBeUndefined();
    expect(parsed.profiles?.default?.api_url).toBe('https://owlette.app');
  });

  it('does not touch sibling profiles', () => {
    const path = tmpPath();
    writeTokenToConfig({
      configPath: path,
      profile: 'default',
      token: 'owk_live_default',
    });
    writeTokenToConfig({
      configPath: path,
      profile: 'dev',
      token: 'owk_test_dev',
    });

    clearTokenFromConfig({ configPath: path, profile: 'default' });

    const parsed = parseToml(readFileSync(path, 'utf-8')) as {
      profiles?: Record<string, { token?: string }>;
    };
    expect(parsed.profiles?.default?.token).toBeUndefined();
    expect(parsed.profiles?.dev?.token).toBe('owk_test_dev');
  });
});

describe('writeProfileConfig', () => {
  it('writes profile metadata without adding a token field', () => {
    const path = tmpPath();

    writeProfileConfig({
      configPath: path,
      profile: 'default',
      apiUrl: 'https://dev.owlette.app',
      environment: 'test',
    });

    const parsed = parseToml(readFileSync(path, 'utf-8')) as {
      profiles?: Record<string, { token?: string; api_url?: string; environment?: string }>;
    };
    expect(parsed.profiles?.default?.token).toBeUndefined();
    expect(parsed.profiles?.default?.api_url).toBe('https://dev.owlette.app');
    expect(parsed.profiles?.default?.environment).toBe('test');
  });

  it('overwrites stale profile api_url metadata', () => {
    const path = tmpPath();
    writeProfileConfig({
      configPath: path,
      profile: 'default',
      apiUrl: 'https://dev.owlette.app',
      environment: 'test',
    });

    writeProfileConfig({
      configPath: path,
      profile: 'default',
      apiUrl: 'https://owlette.app',
      environment: 'live',
    });

    const parsed = parseToml(readFileSync(path, 'utf-8')) as {
      profiles?: Record<string, { api_url?: string; environment?: string }>;
    };
    expect(parsed.profiles?.default?.api_url).toBe('https://owlette.app');
    expect(parsed.profiles?.default?.environment).toBe('live');
  });
});
