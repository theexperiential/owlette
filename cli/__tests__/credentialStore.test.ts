import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearStoredCredential,
  defaultCredentialPath,
  readStoredCredential,
  writeStoredCredential,
} from '../src/credentialStore';

function tmpCredentialPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlette-cli-credentials-'));
  return join(dir, 'credentials.json');
}

describe('credentialStore token-file fallback', () => {
  it('writes and reads profile-scoped credentials', () => {
    const credentialPath = tmpCredentialPath();

    const written = writeStoredCredential({
      credentialPath,
      backend: 'token-file',
      profile: 'dev',
      token: 'owk_test_token',
      apiUrl: 'https://dev.owlette.app',
      environment: 'test',
    });

    expect(written).toEqual({ source: 'token-file', credentialPath });
    expect(existsSync(credentialPath)).toBe(true);

    const stored = readStoredCredential({
      credentialPath,
      backend: 'token-file',
      profile: 'dev',
    });
    expect(stored).toMatchObject({
      source: 'token-file',
      credentialPath,
      token: 'owk_test_token',
      apiUrl: 'https://dev.owlette.app',
      environment: 'test',
    });
  });

  it('keeps sibling profiles when clearing one profile', () => {
    const credentialPath = tmpCredentialPath();
    writeStoredCredential({
      credentialPath,
      backend: 'token-file',
      profile: 'default',
      token: 'owk_live_default',
    });
    writeStoredCredential({
      credentialPath,
      backend: 'token-file',
      profile: 'dev',
      token: 'owk_test_dev',
    });

    expect(clearStoredCredential({ credentialPath, backend: 'token-file', profile: 'default' })).toBe(
      true,
    );
    expect(readStoredCredential({ credentialPath, backend: 'token-file', profile: 'default' })).toBeNull();
    expect(readStoredCredential({ credentialPath, backend: 'token-file', profile: 'dev' })?.token).toBe(
      'owk_test_dev',
    );
  });

  it('derives the token-file path next to config.toml', () => {
    const configPath = join(tmpdir(), 'owlette', 'config.toml');
    expect(defaultCredentialPath(configPath)).toBe(join(tmpdir(), 'owlette', 'credentials.json'));
  });

  it('does not store raw keys in TOML-shaped content', () => {
    const credentialPath = tmpCredentialPath();
    writeStoredCredential({
      credentialPath,
      backend: 'token-file',
      profile: 'default',
      token: 'owk_live_secret',
    });

    const raw = readFileSync(credentialPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).toContain('owk_live_secret');
    expect(raw).not.toContain('[profiles.default]');
  });
});
