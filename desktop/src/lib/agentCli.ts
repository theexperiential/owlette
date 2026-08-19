/**
 * Running the agent's python helper, and reading what it says back.
 *
 * Pairing, leaving a site and filing a bug report all need the agent's cloud
 * client and its encrypted token store, which this app deliberately does not
 * have. The host spawns `agent/src/configure_site.py` instead (see
 * `src-tauri/src/agent_cli.rs`) and forwards every line it writes as an
 * `owlette://agent-cli` event. This module turns that stream into one promise
 * per run.
 *
 * The wire format is one JSON object per line:
 * `{"event": "phrase" | "status" | "authorized" | "done" | "error", "value": …}`
 * — the "Headless modes" section of `configure_site.py` is the other half of
 * this contract, and a change on either side has to be made on both.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Event name the host emits for every line, and for the exit. */
const EVENT_AGENT_CLI = 'owlette://agent-cli'

/** The modes the host will run. Mirrors `agent_cli::MODES`. */
export type AgentMode = 'join' | 'leave' | 'report-issue' | 'reboot-now' | 'dismiss-reboot'

/** The pairing phrase and where to approve it. */
export interface PairPhrase {
  pairPhrase: string
  /** owlette.app/add with the phrase pre-filled. */
  pairingUrl: string
  verificationUri: string
  /** Seconds the phrase stays valid. */
  expiresIn: number
}

/** The outcome of a successful pairing. */
export interface Authorized {
  siteId: string
  /**
   * False when the helper could not restart the service afterwards — NSSM needs
   * rights a standard user does not have. Pairing still succeeded, but the
   * machine will not appear on the dashboard until the service is restarted.
   */
  serviceRestarted: boolean
}

export type AgentEvent =
  | { event: 'phrase'; value: PairPhrase }
  | { event: 'status'; value: string }
  | { event: 'authorized'; value: Authorized }
  | { event: 'done'; value: Record<string, unknown> }
  | { event: 'error'; value: string }

/** Events that end a run. Exactly one is emitted per successful protocol run. */
const TERMINAL_EVENTS = ['authorized', 'done', 'error'] as const

export function isTerminal(event: AgentEvent): boolean {
  return (TERMINAL_EVENTS as readonly string[]).includes(event.event)
}

/** One line of output, or the child's exit. Mirrors `agent_cli::AgentCliEvent`. */
interface AgentCliLine {
  run: string
  stream: 'stdout' | 'stderr' | 'exit'
  line: string | null
  code: number | null
}

/**
 * Parse one stdout line.
 *
 * Anything that is not a well-formed event is ignored rather than thrown:
 * python can write a warning to stdout that we did not ask for, and losing a
 * progress line must never fail a pairing that is otherwise going fine.
 */
export function parseAgentLine(line: string): AgentEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const { event, value } = parsed as { event?: unknown; value?: unknown }

  switch (event) {
    case 'phrase': {
      if (!value || typeof value !== 'object') return null
      const phrase = value as Partial<PairPhrase>
      if (typeof phrase.pairPhrase !== 'string' || !phrase.pairPhrase) return null
      return {
        event: 'phrase',
        value: {
          pairPhrase: phrase.pairPhrase,
          pairingUrl: typeof phrase.pairingUrl === 'string' ? phrase.pairingUrl : '',
          verificationUri:
            typeof phrase.verificationUri === 'string' ? phrase.verificationUri : '',
          expiresIn: typeof phrase.expiresIn === 'number' ? phrase.expiresIn : 600,
        },
      }
    }
    case 'status':
      return typeof value === 'string' ? { event: 'status', value } : null
    case 'authorized': {
      const authorized = (value ?? {}) as { siteId?: unknown; serviceRestarted?: unknown }
      return {
        event: 'authorized',
        value: {
          siteId: typeof authorized.siteId === 'string' ? authorized.siteId : '',
          // Assume the restart worked when the helper did not say: an older
          // helper that omits the field did restart the service.
          serviceRestarted: authorized.serviceRestarted !== false,
        },
      }
    }
    case 'done':
      return {
        event: 'done',
        value: value && typeof value === 'object' ? (value as Record<string, unknown>) : {},
      }
    case 'error':
      return { event: 'error', value: typeof value === 'string' ? value : 'the agent helper failed' }
    default:
      return null
  }
}

export interface AgentRunOutcome {
  /** The process exit code; null when it could not be reaped. */
  code: number | null
  /** The last terminal event seen, or null when the helper died mid-protocol. */
  terminal: AgentEvent | null
  /** Everything written to stderr, for a diagnostic nothing else explains. */
  stderr: string
}

export interface AgentRunOptions {
  /** Payload for `report-issue`; every other mode takes none. */
  payload?: unknown
  onEvent?: (event: AgentEvent) => void
}

export interface AgentRun {
  /** Host-assigned run id. */
  id: string
  /** Resolves when the helper exits, however it exits. */
  completed: Promise<AgentRunOutcome>
  /** Kill the helper. Safe to call after it has already exited. */
  cancel: () => Promise<void>
}

/**
 * The message shown when a run ends without saying why.
 *
 * A helper that exits non-zero having emitted no `error` has crashed before its
 * own handler could run — a missing interpreter, an import error — and the
 * stderr tail is the only useful thing left to show.
 */
function unexplained(outcome: { code: number | null; stderr: string }): string {
  const tail = outcome.stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n')
  if (tail) return tail
  return `the agent helper exited with code ${outcome.code ?? 'unknown'}`
}

/**
 * Start a run and stream it.
 *
 * The event subscription is opened *before* the helper is spawned and buffers
 * everything it sees, because the host can emit the first line before `invoke`
 * has resolved the run id back to us — pairing emits a status line immediately.
 */
export async function startAgentRun(
  mode: AgentMode,
  options: AgentRunOptions = {},
): Promise<AgentRun> {
  const buffered: AgentCliLine[] = []
  let id: string | null = null
  let settle: ((outcome: AgentRunOutcome) => void) | null = null

  let terminal: AgentEvent | null = null
  let stderr = ''

  const completed = new Promise<AgentRunOutcome>((resolve) => {
    settle = resolve
  })

  const handle = (payload: AgentCliLine) => {
    if (payload.run !== id) return

    if (payload.stream === 'stderr') {
      stderr += `${payload.line ?? ''}\n`
      return
    }

    if (payload.stream === 'exit') {
      void unlisten().finally(() => settle?.({ code: payload.code, terminal, stderr }))
      return
    }

    const event = parseAgentLine(payload.line ?? '')
    if (!event) return
    if (isTerminal(event)) terminal = event
    options.onEvent?.(event)
  }

  let stop: UnlistenFn | null = null
  const unlisten = async () => {
    stop?.()
    stop = null
  }

  stop = await listen<AgentCliLine>(EVENT_AGENT_CLI, (event) => {
    if (id === null) {
      buffered.push(event.payload)
      return
    }
    handle(event.payload)
  })

  try {
    id = await invoke<string>('agent_cli_start', {
      mode,
      payload: options.payload ?? null,
    })
  } catch (cause) {
    await unlisten()
    throw cause
  }

  // Drain whatever arrived while the id was in flight, in order.
  for (const payload of buffered.splice(0)) handle(payload)

  return {
    id,
    completed,
    cancel: async () => {
      try {
        await invoke<boolean>('agent_cli_cancel', { run: id })
      } catch {
        // The run had already finished; its exit event settles the promise.
      }
    },
  }
}

/**
 * Run a mode to completion and reject with something worth showing.
 *
 * Used by everything that has no progress to render — leaving a site, filing a
 * report, dismissing a pending reboot.
 */
export async function runAgent(
  mode: AgentMode,
  options: AgentRunOptions = {},
): Promise<AgentRunOutcome> {
  const run = await startAgentRun(mode, options)
  const outcome = await run.completed

  if (outcome.terminal?.event === 'error') throw new Error(outcome.terminal.value)
  if (outcome.terminal === null || outcome.code !== 0) throw new Error(unexplained(outcome))
  return outcome
}

/** Open a file or folder inside the owlette tree with its default handler. */
export function openOwlettePath(path: string): Promise<void> {
  return invoke<void>('open_owlette_path', { path })
}

/** Open an `http(s)` link in the default browser. */
export function openExternalUrl(url: string): Promise<void> {
  return invoke<void>('open_external_url', { url })
}
