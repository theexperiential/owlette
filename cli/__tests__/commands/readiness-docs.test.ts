import { existsSync, readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

describe('CLI readiness docs', () => {
  const docs = [
    'cli/README.md',
    'docs/cli/overview.md',
    'docs/cli/readiness.md',
    'docs/cli/reference/chat.md',
    'docs/cli/reference/deploy.md',
    'docs/cli/reference/machine.md',
    'docs/cli/reference/process.md',
    'docs/cli/reference/roost.md',
    'docs/cli/reference/user.md',
    'docs/cli/reference/webhook.md',
  ]
    .map(readRepoFile)
    .join('\n');

  it('does not point CLI readers at old implementation tracks', () => {
    const staleNeedles = [
      ['dev/active', 'live-view-webrtc'].join('/'),
      ['dev/active', 'owlette-cli'].join('/'),
      ['api', 'sprint'].join('-'),
      ['classic installer', 'stub group'].join(' '),
    ];
    for (const stale of staleNeedles) {
      expect(docs).not.toContain(stale);
    }
    expect(docs).not.toMatch(new RegExp(`${['roost', 'public', 'api'].join('-')} W\\d`, 'i'));
  });

  it('documents rollback as the registered top-level command', () => {
    expect(docs).not.toContain(['owlette roost', 'rollback'].join(' '));
    expect(existsSync(path.join(repoRoot, 'docs/cli/reference/rollback.md'))).toBe(true);
    expect(readRepoFile('docs/cli/readiness.md')).toContain('owlette rollback <roostId>');
  });

  it('captures the only shipped CLI stub and the planned webhook noun', () => {
    const readiness = readRepoFile('docs/cli/readiness.md');
    expect(readiness).toContain('machine live-view');
    expect(readiness).toContain('public-api deferred: live-view-webrtc');
    expect(readiness).toContain('`owlette webhook` is not registered');
  });
});
