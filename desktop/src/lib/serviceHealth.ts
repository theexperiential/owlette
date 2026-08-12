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
