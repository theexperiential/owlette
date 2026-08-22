/**
 * Which owlette a build is talking to, as a short token the UI can badge.
 *
 * The ONLY place in `src/` allowed to name a dev/prod host. Everything else asks
 * here, so pointing the desktop app at a new deployment is a one-file change.
 * Pure — no React, no Tauri — so the surfaces stay testable without a window.
 */

import type { OwletteConfig } from '@/lib/owletteConfig'
import { firebaseSection } from '@/lib/serviceHealth'

/** Production. Needs no badge: an unlabelled app is the real fleet. */
const PRODUCTION_HOST = 'owlette.app'

/** The staging deployment `dev` auto-deploys to. */
const DEV_HOST = 'dev.owlette.app'

/** Hostname of a URL, or '' when it is empty or unparseable. Never throws. */
export function hostOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    // `.host`, not `.hostname` — the port is what tells one local origin from
    // another when a developer runs the web app beside the packaged desktop app.
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Short operator-facing token for a host: null for 'owlette.app' (production
 * needs no badge), 'dev' for 'dev.owlette.app', and the bare host for anything
 * else ('localhost:3000', a preview deploy). '' in → null.
 */
export function environmentToken(host: string): string | null {
  if (!host) return null
  if (host === PRODUCTION_HOST) return null
  if (host === DEV_HOST) return 'dev'
  return host
}

/**
 * The host a requested server names, for the window before anything has
 * answered and there is no URL to read a host out of. '' when no server was
 * requested — the caller then names no host at all rather than guessing one.
 *
 * Only ever a fallback: a URL the server itself minted is authoritative, since
 * it reports which deployment actually replied.
 */
export function hostForServer(server: 'dev' | 'prod' | null | undefined): string {
  if (server === 'dev') return DEV_HOST
  if (server === 'prod') return PRODUCTION_HOST
  return ''
}

/**
 * The environment a parsed config.json describes, as an `environmentToken`.
 * Reads `firebase.api_base` first (it is the URL the service actually uses),
 * then falls back to the top-level `environment` string ('development' → 'dev',
 * 'production' → null). null when the config is null, has neither field, or
 * describes production.
 */
export function environmentFromConfig(config: OwletteConfig | null): string | null {
  if (!config) return null

  // An api_base that does not parse is no better than an absent one, so it
  // falls through to `environment` rather than reporting production.
  const host = hostOf(firebaseSection(config).api_base)
  if (host) return environmentToken(host)

  const environment = config.environment
  if (typeof environment !== 'string' || !environment) return null
  if (environment === 'production') return null
  return environment === 'development' ? 'dev' : environment
}
