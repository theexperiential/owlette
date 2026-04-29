/**
 * Contract tests for the sync_pull command payload emitted by the
 * distribution fan-out function.
 *
 * The agent's `_handle_sync_pull` (agent/src/sync_commands.py) calls
 * `_require_str(cmd_data, '<field>')` for every field below — a missing
 * or renamed field crashes the agent before any disk work. Two other
 * call sites (web routes /api/roosts/{roostId}/deploy and /resync)
 * emit the same shape; this test pins the contract for the fan-out
 * trigger so all three stay aligned.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncPullCommand, syncPullCommandId } from '../src/lib/syncPullCommand';

const SENTINEL_TIMESTAMP = '__server_timestamp__';

describe('buildSyncPullCommand', () => {
  it('emits the exact field names the agent _require_str()s', () => {
    const cmd = buildSyncPullCommand(
      'site-1',
      'roost-1',
      'v1',
      'https://r2.example/version-body',
      '~/Documents/Owlette',
      SENTINEL_TIMESTAMP,
    );

    // Required by _handle_sync_pull. Renaming any of these crashes the agent.
    assert.equal(cmd.type, 'sync_pull');
    assert.equal(cmd.site_id, 'site-1');
    assert.equal(cmd.roost_id, 'roost-1');
    assert.equal(cmd.version_id, 'v1');
    assert.equal(cmd.version_url, 'https://r2.example/version-body');
    assert.equal(cmd.extract_root, '~/Documents/Owlette');
    assert.equal(cmd.queued_at, SENTINEL_TIMESTAMP);
  });

  it('does not emit the legacy `folder_id` key', () => {
    // Regression guard: an earlier version of distributionFanout.ts
    // queued `folder_id: roostId`, which the agent's `_require_str`
    // call rejected before any disk work. Every fanout-triggered sync
    // failed silently. Keep this assertion forever.
    const cmd = buildSyncPullCommand('s', 'r', 'v', 'u', 'e', null);
    assert.equal('folder_id' in cmd, false);
  });

  it('emits exactly the documented field set (no extras, no gaps)', () => {
    const cmd = buildSyncPullCommand('s', 'r', 'v', 'u', 'e', null);
    assert.deepEqual(
      Object.keys(cmd).sort(),
      [
        'extract_root',
        'queued_at',
        'roost_id',
        'site_id',
        'type',
        'version_id',
        'version_url',
      ],
    );
  });
});

describe('syncPullCommandId', () => {
  it('is deterministic per (roostId, versionId)', () => {
    assert.equal(
      syncPullCommandId('roost-1', 'v1'),
      syncPullCommandId('roost-1', 'v1'),
    );
  });

  it('encodes both ids so retries don\'t duplicate across versions or roosts', () => {
    assert.equal(syncPullCommandId('r1', 'v1'), 'roost_sync_r1_v1');
    assert.notEqual(
      syncPullCommandId('r1', 'v1'),
      syncPullCommandId('r1', 'v2'),
    );
    assert.notEqual(
      syncPullCommandId('r1', 'v1'),
      syncPullCommandId('r2', 'v1'),
    );
  });
});
