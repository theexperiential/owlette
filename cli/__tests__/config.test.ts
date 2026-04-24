import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_API_URL,
  _resetConfigCache,
  loadConfig,
} from '../src/config';

function withConfigFile(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'roost-cli-config-'));
  const path = join(dir, 'config.toml');
  writeFileSync(path, toml, 'utf-8');
  return path;
}

beforeEach(() => _resetConfigCache());

describe('loadConfig', () => {
  it('returns built-in defaults when no config + no env', () => {
    const config = loadConfig({
      configPath: '/nonexistent/roost/config.toml',
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
    const config = loadConfig({ configPath: path, env: {}, reload: true });
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
    const config = loadConfig({ configPath: path, env: {}, reload: true });
    expect(config.apiUrl).toBe('https://top-level.example');
    expect(config.environment).toBe('live');
  });

  it('ROOST_TOKEN env overrides the config file', () => {
    const path = withConfigFile(`
[profiles.default]
token = "owk_live_fromfile"
`);
    const config = loadConfig({
      configPath: path,
      env: { ROOST_TOKEN: 'owk_live_fromenv' },
      reload: true,
    });
    expect(config.token).toBe('owk_live_fromenv');
  });

  it('ROOST_API_URL env overrides profile api_url', () => {
    const path = withConfigFile(`
[profiles.default]
api_url = "https://owlette.app"
`);
    const config = loadConfig({
      configPath: path,
      env: { ROOST_API_URL: 'https://custom.example' },
      reload: true,
    });
    expect(config.apiUrl).toBe('https://custom.example');
  });

  it('ROOST_PROFILE env picks profile when no explicit --profile', () => {
    const path = withConfigFile(`
[profiles.dev]
token = "owk_test_devprofile"
`);
    const config = loadConfig({
      configPath: path,
      env: { ROOST_PROFILE: 'dev' },
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
    const config = loadConfig({ configPath: path, env: {}, reload: true });
    expect(config.environment).toBeNull();
  });
});
