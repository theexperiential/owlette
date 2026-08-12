import { describe, expect, it } from 'vitest'
import type { ServiceStatus } from './ipc'
import { deriveFooterState, siteIdOf, type ServiceStatusFile } from './serviceHealth'

const healthy: ServiceStatus = {
  installed: true,
  running: true,
  state: 'running',
  startType: 'auto_start',
  statusFile: { exists: true, ageSecs: 12, stale: false },
}

const connected: ServiceStatusFile = {
  service: { running: true, last_update: 1_786_562_574, version: '2.12.21' },
  firebase: { enabled: true, connected: true, site_id: 'default_site', last_heartbeat: 0 },
  health: { status: 'ok', error_code: null, error_message: null },
}

const joined = { firebase: { enabled: true, site_id: 'default_site' } }

describe('footer state', () => {
  it('says nothing until the first status query lands', () => {
    expect(deriveFooterState({ status: null, statusFile: null, config: null })).toMatchObject({
      label: 'checking',
      tone: 'muted',
    })
  })

  it('is connected when the service says so', () => {
    expect(
      deriveFooterState({ status: healthy, statusFile: connected, config: joined }),
    ).toMatchObject({ label: 'connected', tone: 'ok', serviceDown: false })
  })

  it('reports a stopped service ahead of anything the file claims', () => {
    const stopped: ServiceStatus = { ...healthy, running: false, state: 'stopped' }

    expect(
      deriveFooterState({ status: stopped, statusFile: connected, config: joined }),
    ).toMatchObject({ label: 'service not running', tone: 'error', serviceDown: true })
  })

  it('treats a two-minute-old status file as the service being gone', () => {
    const wedged: ServiceStatus = {
      ...healthy,
      statusFile: { exists: true, ageSecs: 300, stale: true },
    }
    const state = deriveFooterState({ status: wedged, statusFile: connected, config: joined })

    expect(state.label).toBe('service not running')
    expect(state.detail).toMatch(/status file/)
  })

  it('says so when the service is not installed at all', () => {
    const absent: ServiceStatus = { ...healthy, installed: false }

    expect(deriveFooterState({ status: absent, statusFile: null, config: joined }).detail).toMatch(
      /not installed/,
    )
  })

  it('is disabled when cloud features are off in the config', () => {
    expect(
      deriveFooterState({
        status: healthy,
        statusFile: connected,
        config: { firebase: { enabled: false, site_id: 'default_site' } },
      }),
    ).toMatchObject({ label: 'disabled', tone: 'muted' })
  })

  it('says removed from site when the site id has been cleared', () => {
    expect(
      deriveFooterState({
        status: healthy,
        statusFile: connected,
        config: { firebase: { enabled: true, site_id: '' } },
      }),
    ).toMatchObject({ label: 'removed from site', tone: 'error' })
  })

  it('reads the service’s own auth verdict rather than opening the token store', () => {
    const unauthenticated: ServiceStatusFile = {
      ...connected,
      firebase: { ...connected.firebase, connected: false },
      health: { status: 'auth_error', error_code: 'auth_error', error_message: 'token rejected' },
    }

    expect(
      deriveFooterState({ status: healthy, statusFile: unauthenticated, config: joined }),
    ).toMatchObject({
      label: 'authentication required',
      tone: 'warn',
      detail: 'token rejected',
    })
  })

  it('is disconnected when the service is up but not reaching owlette', () => {
    const offline: ServiceStatusFile = {
      ...connected,
      firebase: { ...connected.firebase, connected: false },
      health: { status: 'network_error', error_code: 'network_error', error_message: 'dns failed' },
    }

    expect(
      deriveFooterState({ status: healthy, statusFile: offline, config: joined }),
    ).toMatchObject({ label: 'disconnected', tone: 'error' })
  })

  it('does not claim a connection when the status file could not be read', () => {
    expect(
      deriveFooterState({ status: healthy, statusFile: null, config: joined }).label,
    ).toBe('disconnected')
  })
})

describe('site id', () => {
  it('prefers the config, which is what the service reads', () => {
    expect(siteIdOf({ firebase: { site_id: 'studio' } }, connected)).toBe('studio')
  })

  it('falls back to the status file before giving up', () => {
    expect(siteIdOf({ firebase: {} }, connected)).toBe('default_site')
    expect(siteIdOf(null, null)).toBe('')
  })
})
