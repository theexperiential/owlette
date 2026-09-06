import { describe, expect, it } from 'vitest'
import type { ServiceStatus } from './ipc'
import {
  deriveFooterState,
  footerSentence,
  isPaired,
  scheduleTimezoneOf,
  siteIdOf,
  siteNameOf,
  type FooterState,
  type ServiceStatusFile,
} from './serviceHealth'

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

describe('site name', () => {
  const named: ServiceStatusFile = {
    ...connected,
    firebase: { ...connected.firebase, site_name: 'TEC' },
  }

  it('prefers the name the service published', () => {
    expect(siteNameOf(joined, named)).toBe('TEC')
  })

  it('falls back to the id, never to nothing', () => {
    expect(siteNameOf(joined, connected)).toBe('default_site')
    expect(siteNameOf(joined, { firebase: { site_id: 'default_site', site_name: '' } })).toBe(
      'default_site',
    )
    expect(siteNameOf(joined, null)).toBe('default_site')
  })

  it('ignores a name published for a site this machine has left', () => {
    // config.json is rewritten first on a join or a leave, so between that and
    // the service's next status write the file still names the old site.
    // Naming it would be worse than saying nothing about it.
    expect(siteNameOf({ firebase: { enabled: true, site_id: 'studio' } }, named)).toBe('studio')
  })

  it('has nothing to say about an unpaired machine', () => {
    expect(siteNameOf({ firebase: { enabled: false, site_id: '' } }, { firebase: {} })).toBe('')
  })

  it('trusts the status file before config.json has been read', () => {
    expect(siteNameOf(null, named)).toBe('TEC')
  })
})

describe('schedule timezone', () => {
  const optedIn: ServiceStatusFile = {
    ...connected,
    firebase: { ...connected.firebase, schedule_timezone: 'America/New_York' },
  }

  it('takes the zone the service published for this site', () => {
    expect(scheduleTimezoneOf(joined, optedIn)).toBe('America/New_York')
  })

  it('reads it before config.json has landed, like the site name does', () => {
    expect(scheduleTimezoneOf(null, optedIn)).toBe('America/New_York')
  })

  it('means this machine\'s own clock whenever the site published nothing', () => {
    // Opted out, never asked, and an agent too old to publish the field at all
    // are one state to every surface: the legacy machine-local wording.
    expect(scheduleTimezoneOf(joined, connected)).toBe('')
    expect(
      scheduleTimezoneOf(joined, {
        firebase: { site_id: 'default_site', schedule_timezone: '' },
      }),
    ).toBe('')
    expect(scheduleTimezoneOf(joined, null)).toBe('')
    expect(scheduleTimezoneOf(null, null)).toBe('')
  })

  it('ignores a zone published for a site this machine has left', () => {
    // The same window between a join/leave rewriting config.json and the
    // service's next status write that `siteNameOf` guards. Naming another
    // site's clock here would mislabel every schedule in the editor.
    expect(scheduleTimezoneOf({ firebase: { enabled: true, site_id: 'studio' } }, optedIn)).toBe('')
  })
})

describe('pairing', () => {
  it('needs both halves of the firebase block', () => {
    expect(isPaired(joined)).toBe(true)
    expect(isPaired({ firebase: { enabled: true, site_id: '' } })).toBe(false)
    expect(isPaired({ firebase: { enabled: false, site_id: 'default_site' } })).toBe(false)
    expect(isPaired({})).toBe(false)
  })

  it('answers neither way until config.json has been read', () => {
    // The menu and the footer both branch on this; a momentary `false` would
    // offer to pair a machine that is already paired.
    expect(isPaired(null)).toBeNull()
  })
})

describe('footer sentence', () => {
  const state = (label: string): FooterState => ({ label, tone: 'ok', detail: null, serviceDown: false })

  it('reads "<host> is connected to <site>"', () => {
    expect(footerSentence(state('connected'), 'default_site', 'TEC-A4D')).toEqual({
      before: 'TEC-A4D is ',
      after: ' to default_site',
    })
  })

  it('reads "<host> is disconnected from <site>"', () => {
    expect(footerSentence(state('disconnected'), 'default_site', 'TEC-A4D')).toEqual({
      before: 'TEC-A4D is ',
      after: ' from default_site',
    })
  })

  it('hangs the host off states that are not connection sentences', () => {
    expect(footerSentence(state('service not running'), '', 'TEC-A4D').after).toBe(' on TEC-A4D')
    expect(footerSentence(state('removed from site'), '', 'TEC-A4D').before).toBe('TEC-A4D was ')
    expect(footerSentence(state('authentication required'), '', 'TEC-A4D').after).toBe(' for TEC-A4D')
  })

  it('leaves self-sufficient states alone', () => {
    expect(footerSentence(state('checking'), 'default_site', 'TEC-A4D')).toEqual({ before: '', after: '' })
  })

  it('falls back to the segment form until the hostname is known', () => {
    expect(footerSentence(state('connected'), 'default_site', null)).toEqual({
      before: '',
      after: ' · default_site',
    })
  })
})
