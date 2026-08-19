import { describe, expect, it } from 'vitest'
import type { ClassifiedDrop, DropResult, ProcessEntryDraft } from './dropClassifier'
import {
  cardBlockedReason,
  dequeueCard,
  describeKind,
  enqueueCards,
  triage,
  updateCard,
  type DropCard,
} from './dropQueue'

function draft(fields: Partial<ProcessEntryDraft> = {}): ProcessEntryDraft {
  return {
    name: 'player',
    exe_path: 'C:\\apps\\player.exe',
    file_path: '',
    cwd: 'C:\\apps',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '5',
    launch_mode: 'off',
    autolaunch: false,
    schedules: null,
    ...fields,
  }
}

function classified(path: string, overrides: Partial<ClassifiedDrop> = {}): ClassifiedDrop {
  return {
    kind: 'executable',
    path,
    entry: draft({ name: path.split('\\').pop()?.replace(/\.exe$/i, '') ?? 'x', exe_path: path }),
    needsInput: [],
    warnings: [],
    ...overrides,
  }
}

function card(path: string, overrides: Partial<DropCard> = {}): DropCard {
  const { kind, entry, needsInput, warnings } = classified(path)
  return { kind, path, entry, needsInput, warnings, ...overrides }
}

describe('triage', () => {
  it('splits what can be proposed from what cannot', () => {
    const results: DropResult[] = [
      classified('C:\\apps\\player.exe'),
      { kind: 'unsupported', path: 'C:\\notes.txt', reason: 'owlette does not know how to launch a .txt file' },
      classified('C:\\apps\\signage.exe'),
    ]

    const { cards, rejected } = triage(results)

    expect(cards.map((entry) => entry.path)).toEqual([
      'C:\\apps\\player.exe',
      'C:\\apps\\signage.exe',
    ])
    expect(rejected.map((drop) => drop.path)).toEqual(['C:\\notes.txt'])
  })

  it('carries the classifier’s warnings onto the card', () => {
    const { cards } = triage([
      classified('C:\\my shows\\start.ps1', { kind: 'script', warnings: ['powershell mishandles…'] }),
    ])

    expect(cards[0].warnings).toEqual(['powershell mishandles…'])
  })
})

describe('naming a kind', () => {
  it('picks the article the label needs', () => {
    expect(describeKind('executable')).toBe('an application')
    expect(describeKind('script')).toBe('a script')
    expect(describeKind('touchdesigner')).toBe('a touchdesigner project')
    expect(describeKind('unity')).toBe('a unity build')
  })
})

describe('the queue', () => {
  it('keeps drops in the order they landed', () => {
    const queue = enqueueCards([], [card('C:\\a.exe'), card('C:\\b.exe')])

    expect(enqueueCards(queue, [card('C:\\c.exe')]).map((entry) => entry.path)).toEqual([
      'C:\\a.exe',
      'C:\\b.exe',
      'C:\\c.exe',
    ])
  })

  it('ignores a path that is already waiting, however it is spelled', () => {
    const queue = enqueueCards([], [card('C:\\apps\\Player.exe')])

    // Windows would open both of these; they are one file and one card.
    const next = enqueueCards(queue, [card('c:/apps/player.exe'), card('C:\\apps\\other.exe')])

    expect(next.map((entry) => entry.path)).toEqual(['C:\\apps\\Player.exe', 'C:\\apps\\other.exe'])
  })

  it('drops a card once it has been confirmed or skipped', () => {
    const queue = enqueueCards([], [card('C:\\a.exe'), card('C:\\b.exe')])

    expect(dequeueCard(queue, 'C:\\a.exe').map((entry) => entry.path)).toEqual(['C:\\b.exe'])
  })

  it('edits one card without touching the others', () => {
    const queue = enqueueCards([], [card('C:\\a.exe'), card('C:\\b.exe')])

    const next = updateCard(queue, 'C:\\a.exe', { name: 'lobby wall' })

    expect(next[0].entry.name).toBe('lobby wall')
    expect(next[0].entry.exe_path).toBe('C:\\a.exe')
    expect(next[1]).toBe(queue[1])
    expect(queue[0].entry.name).toBe('a')
  })
})

describe('what stops a card being added', () => {
  it('accepts a card the classifier filled in completely', () => {
    expect(cardBlockedReason(card('C:\\a.exe'), ['player'])).toBeNull()
  })

  it('refuses a nameless entry — nothing could find it again in the list', () => {
    expect(cardBlockedReason(card('C:\\a.exe', { entry: draft({ name: '  ' }) }), [])).toBe(
      'a name is required',
    )
  })

  it('asks for touchdesigner by name when the machine has none', () => {
    const missing = card('C:\\shows\\a.toe', {
      kind: 'touchdesigner',
      entry: draft({ name: 'a', exe_path: '' }),
      needsInput: ['exe_path'],
    })

    expect(cardBlockedReason(missing, [])).toMatch(/touchdesigner was not found/)
  })

  it('asks for an executable for anything else that has none', () => {
    const missing = card('C:\\shows\\a.py', {
      kind: 'script',
      entry: draft({ name: 'a', exe_path: '' }),
      needsInput: ['exe_path'],
    })

    expect(cardBlockedReason(missing, [])).toMatch(/point this at the executable/)
  })

  it('refuses a name another process already has', () => {
    // The web api answers a duplicate name with a 409, so this would be written
    // to disk and then rejected in the cloud with nothing on screen to say so.
    expect(cardBlockedReason(card('C:\\a.exe', { entry: draft({ name: 'Player' }) }), ['player'])).toBe(
      'a process named Player already exists on this machine',
    )
  })
})
