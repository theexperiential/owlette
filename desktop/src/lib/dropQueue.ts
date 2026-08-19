/**
 * The queue between "files landed on the window" and "entries in config.json".
 *
 * A drop is never written straight through. The classifier's output is a
 * proposal — it guesses a name, picks an interpreter, and sometimes cannot find
 * the host application at all — so each classified path becomes a card the
 * operator reads, edits and confirms one at a time. Dropping nine files
 * therefore produces nine cards and, if the operator confirms them all, nine
 * writes: one entry per write, so a mistake on card seven leaves the first six
 * exactly where they are.
 *
 * Everything here is pure and total. The component owns the array; this module
 * only says what the next one should be.
 */

import type {
  DropKind,
  DropResult,
  NeedsInput,
  ProcessEntryDraft,
  UnsupportedDrop,
} from '@/lib/dropClassifier'

/**
 * One proposed process, waiting to be confirmed.
 *
 * `path` is the identity: the same file dropped twice while its card is still
 * on screen is the same card, not two, and there is nothing else about a drop
 * that is reliably unique. (Two entries for one path is a legitimate thing to
 * want — a second copy with different arguments, say — it is just not something
 * a double drop should produce silently.)
 */
export interface DropCard {
  kind: DropKind
  path: string
  entry: ProcessEntryDraft
  /** Fields the classifier could not derive; the card must ask for them. */
  needsInput: NeedsInput[]
  /** Lowercase notes to show with the card. Usually empty. */
  warnings: string[]
}

export interface DropTriage {
  cards: DropCard[]
  /** Paths there is nothing to propose for; the caller reports these and moves on. */
  rejected: UnsupportedDrop[]
}

/** What each kind is called on screen — lowercase, like the rest of the ui. */
export const DROP_KIND_LABELS: Record<DropKind, string> = {
  touchdesigner: 'touchdesigner project',
  unity: 'unity build',
  executable: 'application',
  script: 'script',
}

/**
 * The article each label takes.
 *
 * Data rather than a rule: "an application" but "a unity build", which no test
 * on the first letter gets right.
 */
const KIND_ARTICLES: Record<DropKind, string> = {
  touchdesigner: 'a',
  unity: 'a',
  executable: 'an',
  script: 'a',
}

/** `a script`, `an application` — for a sentence about what a drop turned out to be. */
export function describeKind(kind: DropKind): string {
  return `${KIND_ARTICLES[kind]} ${DROP_KIND_LABELS[kind]}`
}

/** Split one classification pass into cards to show and paths to report. */
export function triage(results: readonly DropResult[]): DropTriage {
  const cards: DropCard[] = []
  const rejected: UnsupportedDrop[] = []

  for (const result of results) {
    if (result.kind === 'unsupported') rejected.push(result)
    else {
      cards.push({
        kind: result.kind,
        path: result.path,
        entry: result.entry,
        needsInput: result.needsInput,
        warnings: result.warnings,
      })
    }
  }

  return { cards, rejected }
}

/** Append cards for paths that are not already waiting. */
export function enqueueCards(
  queue: readonly DropCard[],
  incoming: readonly DropCard[],
): DropCard[] {
  const queued = new Set(queue.map((card) => pathKey(card.path)))
  const next = [...queue]

  for (const card of incoming) {
    const key = pathKey(card.path)
    if (queued.has(key)) continue
    queued.add(key)
    next.push(card)
  }

  return next
}

/** Drop one card, whether it was confirmed or skipped. */
export function dequeueCard(queue: readonly DropCard[], path: string): DropCard[] {
  const key = pathKey(path)
  return queue.filter((card) => pathKey(card.path) !== key)
}

/** Apply an operator's edit to the card for `path`. */
export function updateCard(
  queue: readonly DropCard[],
  path: string,
  patch: Partial<ProcessEntryDraft>,
): DropCard[] {
  const key = pathKey(path)
  return queue.map((card) =>
    pathKey(card.path) === key ? { ...card, entry: { ...card.entry, ...patch } } : card,
  )
}

/**
 * Why this card cannot be added yet, in the operator's words.
 *
 * The duplicate-name check is not cosmetic: the web api answers a second
 * process with an existing name with a 409, so an entry that slips past here
 * would be written to disk, uploaded by the service, and silently rejected in
 * the cloud — a divergence nothing on this machine would ever show.
 */
export function cardBlockedReason(
  card: DropCard,
  existingNames: readonly string[],
): string | null {
  const name = card.entry.name.trim()
  if (!name) return 'a name is required'

  if (!card.entry.exe_path.trim()) {
    return card.kind === 'touchdesigner'
      ? 'touchdesigner was not found on this machine — point this at TouchDesigner.exe'
      : 'no program was found to run this — point this at the executable'
  }

  const taken = existingNames.some((existing) => existing.trim().toLowerCase() === name.toLowerCase())
  return taken ? `a process named ${name} already exists on this machine` : null
}

/** Case-insensitive, separator-agnostic — how Windows compares two paths. */
function pathKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}
