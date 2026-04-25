import { _internals } from '../src/commands/deploy';

const { formatDeployResult } = _internals;

describe('formatDeployResult', () => {
  const base = {
    rolloutId: 'vrs_01',
    versionId: 'vrs_01',
    siteId: 'site-1',
    roostId: 'rst_abc',
    extractRoot: '~/Documents/roosts',
    versionUrl: 'https://r2/.../vrs_01.json',
  };

  it('labels real rollouts as "rollout started" and lists canary/fleet', () => {
    const out = formatDeployResult(
      {
        ...base,
        stage: 'canary',
        canary: ['m-1'],
        fleet: ['m-2', 'm-3'],
      },
      'rst_abc',
    );
    expect(out).toContain('rollout started');
    expect(out).toContain('version       vrs_01');
    expect(out).toContain('canary (1)');
    expect(out).toContain('- m-1');
    expect(out).toContain('fleet (2)');
    expect(out).toContain('- m-2');
    expect(out).toContain('- m-3');
  });

  it('labels dry-run plans distinctly', () => {
    const out = formatDeployResult(
      {
        ...base,
        stage: 'canary',
        canary: ['m-1'],
        fleet: [],
        dryRun: true,
      },
      'rst_abc',
    );
    expect(out).toContain('dry-run plan');
    expect(out).toContain('(none)'); // empty fleet
  });

  it('surfaces the alreadyRunning flag on idempotent re-trigger', () => {
    const out = formatDeployResult(
      {
        ...base,
        stage: 'canary',
        canary: ['m-1'],
        fleet: [],
        alreadyRunning: true,
      },
      'rst_abc',
    );
    expect(out).toContain('rollout already in flight');
  });

  it('renders scheduled deploys with the warning line', () => {
    const out = formatDeployResult(
      {
        ...base,
        stage: 'scheduled',
        canary: [],
        fleet: [],
        scheduled: { at: '2026-05-01T00:00:00Z', warning: 'sweeper ships in wave 4' },
      },
      'rst_abc',
    );
    expect(out).toContain('scheduled');
    expect(out).toContain('2026-05-01T00:00:00Z');
    expect(out).toContain('sweeper ships in wave 4');
  });
});
