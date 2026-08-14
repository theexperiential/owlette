/**
 * The status footer's single source of truth.
 *
 * Three inputs, deliberately: the SCM's view of `OwletteService` and the age of
 * `tmp/service_status.json` (both from the host), the contents of that file,
 * and the `firebase` block of `config.json`. The legacy GUI mixed in a fourth —
 * it opened the encrypted token store to decide whether authentication was the
 * problem — which this app will not do; tokens are the service's business
 * (`owlette_gui.py:2403-2408`). The service already publishes that verdict as a
 * health probe (`health_probe.STATUS_AUTH_ERROR`), so we read it instead.
 */

import { isServiceDown, type ServiceStatus } from '@/lib/ipc'
import type { OwletteConfig } from '@/lib/owletteConfig'

/** `tmp/service_status.json`, as written by `owlette_service._write_service_status`. */
export interface ServiceStatusFile {
  service?: {
    running?: boolean
    last_update?: number
    version?: string
  }
  firebase?: {
    enabled?: boolean
    connected?: boolean
    site_id?: string
    /**
     * The site's display name ("TEC"), as the service last read it from
     * `sites/{site_id}`. Empty whenever the service has not been able to read
     * it — an older agent, a machine that has never connected, or a token
     * without site-level read permission — so it is never the only thing a
     * surface can say about the site.
     */
    site_name?: string
    last_heartbeat?: number
  }
  health?: {
    status?: string
    error_code?: string | null
    error_message?: string | null
    checked_at?: number
    probe_results?: Record<string, boolean>
  }
  [key: string]: unknown
}

export type FooterTone = 'ok' | 'warn' | 'error' | 'muted'

export interface FooterState {
  /** Lowercase copy for the status word. */
  label: string
  tone: FooterTone
  /** Longer explanation, when there is one worth a tooltip. */
  detail: string | null
  /** True while the service is not supervising this machine. */
  serviceDown: boolean
}

export const FOOTER_TONE_CLASS: Record<FooterTone, string> = {
  ok: 'text-green-500',
  warn: 'text-amber-400',
  error: 'text-red-400',
  muted: 'text-muted-foreground',
}

export const FOOTER_DOT_CLASS: Record<FooterTone, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
  muted: 'bg-muted-foreground/60',
}

/** The `health.error_code` the service writes when the token store will not authenticate. */
const AUTH_ERROR = 'auth_error'

export interface FooterInputs {
  /** SCM state + status-file freshness, or null before the first query lands. */
  status: ServiceStatus | null
  /** Parsed `service_status.json`, or null when it could not be read. */
  statusFile: ServiceStatusFile | null
  /** Parsed `config.json`, or null before the first read lands. */
  config: OwletteConfig | null
}

interface FirebaseSection {
  enabled?: boolean
  site_id?: string
}

function firebaseSection(config: OwletteConfig | null): FirebaseSection {
  const section = config?.firebase
  return section && typeof section === 'object' ? (section as FirebaseSection) : {}
}

/** The site this machine belongs to, config first — it is what the service reads. */
export function siteIdOf(config: OwletteConfig | null, statusFile: ServiceStatusFile | null): string {
  return firebaseSection(config).site_id || statusFile?.firebase?.site_id || ''
}

/**
 * What to call this machine's site on screen: its display name when the
 * service has published one, its id otherwise.
 *
 * The id is the truth and stays in every log line, but it is an identifier
 * ("default_site") where the operator's word for the place is a name ("TEC") —
 * the same one the dashboard's manage-sites dialog shows. Only the service can
 * resolve it, so it arrives through `service_status.json`.
 *
 * The published name is used only when it describes the site the machine is
 * actually in. Between a join or a leave and the service's next status write
 * the two disagree — config.json is rewritten first — and a stale name is worse
 * than an id: it would name the site this machine just left.
 */
export function siteNameOf(
  config: OwletteConfig | null,
  statusFile: ServiceStatusFile | null,
): string {
  const site = siteIdOf(config, statusFile)
  const published = statusFile?.firebase
  if (published?.site_name && published.site_id === site) return published.site_name
  return site
}

/**
 * Whether this machine belongs to a site.
 *
 * Read from `config.json` rather than from the service's status file: the
 * config is what the service acts on, and it is what joining and leaving
 * rewrite. Null before the first read lands — neither paired nor unpaired — so
 * that an affordance offered to one of those states does not flash on startup.
 */
export function isPaired(config: OwletteConfig | null): boolean | null {
  if (!config) return null
  const firebase = firebaseSection(config)
  return Boolean(firebase.enabled && firebase.site_id)
}

/**
 * Resolve the footer's state.
 *
 * Order matters and is not the legacy GUI's, because one case outranks
 * everything it used to check: a service that is stopped — or one whose status
 * file has not been rewritten for two minutes, which the tray already treats as
 * stopped (`owlette_tray.read_service_status`) — is not connected to anything,
 * and reporting its last known cloud state would be a green light on a machine
 * nobody is supervising.
 */
export function deriveFooterState({ status, statusFile, config }: FooterInputs): FooterState {
  // Before the first SCM query lands there is nothing to report; saying
  // "disconnected" for those few milliseconds would be a lie that flashes.
  if (!status) {
    return { label: 'checking', tone: 'muted', detail: null, serviceDown: false }
  }

  if (isServiceDown(status)) {
    return {
      label: 'service not running',
      tone: 'error',
      detail: !status.installed
        ? 'OwletteService is not installed on this machine'
        : status.statusFile.stale && status.running
          ? 'the service is running but has not written its status file for over two minutes'
          : 'nothing is supervising this machine right now',
      serviceDown: true,
    }
  }

  const firebase = firebaseSection(config)
  if (config && !firebase.enabled) {
    return {
      label: 'disabled',
      tone: 'muted',
      detail: 'cloud features are turned off in config.json',
      serviceDown: false,
    }
  }

  if (config && !firebase.site_id) {
    return {
      label: 'removed from site',
      tone: 'error',
      detail: 'this machine is no longer assigned to a site',
      serviceDown: false,
    }
  }

  if (statusFile?.firebase?.connected) {
    return { label: 'connected', tone: 'ok', detail: null, serviceDown: false }
  }

  if (statusFile?.health?.error_code === AUTH_ERROR) {
    return {
      label: 'authentication required',
      tone: 'warn',
      detail: statusFile.health?.error_message ?? 'the service could not authenticate with owlette',
      serviceDown: false,
    }
  }

  return {
    label: 'disconnected',
    tone: 'error',
    detail: statusFile?.health?.error_message ?? 'the service is running but not reaching owlette',
    serviceDown: false,
  }
}

export interface FooterSentence {
  /** Muted text before the status word ("TEC-A4D is "). Empty when none. */
  before: string
  /** Muted text after the status word (" to TEC"). Empty when none. */
  after: string
}

/**
 * The muted glue that turns the footer's status word into a sentence:
 * "TEC-A4D is [connected] to TEC". The status word itself keeps its tone
 * colour, so only the words around it are produced here. States that don't fit
 * a sentence fall back to the bare status word, and before the hostname is
 * known the site is appended the old segment way rather than pretending "is
 * connected to" with no subject.
 *
 * `site` is whatever the machine's site should be called on screen — see
 * {@link siteNameOf}. This function does not care which of the two it got.
 */
export function footerSentence(state: FooterState, site: string, hostname: string | null): FooterSentence {
  if (!hostname) {
    return { before: '', after: site ? ` · ${site}` : '' }
  }
  switch (state.label) {
    case 'connected':
      return { before: `${hostname} is `, after: site ? ` to ${site}` : '' }
    case 'disconnected':
      return { before: `${hostname} is `, after: site ? ` from ${site}` : '' }
    case 'service not running':
      return { before: '', after: ` on ${hostname}` }
    case 'removed from site':
      return { before: `${hostname} was `, after: '' }
    case 'authentication required':
      return { before: '', after: ` for ${hostname}` }
    default:
      // "checking" and "disabled" say everything by themselves.
      return { before: '', after: '' }
  }
}
