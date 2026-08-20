import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ScheduleEditor } from '@/components/ScheduleEditor'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ScheduleBlock } from '@/lib/owletteConfig'

/**
 * Copied verbatim from a live `config.json` on a paired machine (the `touch`
 * entry, authored from the dashboard). Every "shape the web writes" assertion
 * is measured against this, key for key.
 */
const WEB_AUTHORED_DEFAULT: ScheduleBlock[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
]

/** A block the web's standalone dialog wrote — same fields plus a colour slot. */
const WEB_AUTHORED_COLOURED: ScheduleBlock[] = [
  {
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    ranges: [{ start: '09:00', stop: '17:00' }],
    colorIndex: 0,
  },
]

function setup(schedules: ScheduleBlock[] | null = null) {
  const onSave = vi.fn()
  const onClose = vi.fn()

  render(
    <TooltipProvider>
      <ScheduleEditor open schedules={schedules} onClose={onClose} onSave={onSave} />
    </TooltipProvider>,
  )

  return {
    onSave,
    onClose,
    /** What the editor would write right now. */
    save: () => {
      fireEvent.click(screen.getByRole('button', { name: 'save schedule' }))
      return onSave.mock.calls.at(-1)?.[0] as ScheduleBlock[] | undefined
    },
  }
}

/** The two time boxes of the first range, addressed by what they display. */
function time(display: string): HTMLInputElement {
  return screen.getByDisplayValue(display) as HTMLInputElement
}

describe('seeding the draft', () => {
  it('prefills the web default when the entry has no windows', () => {
    setup(null)

    expect(time('9:00 am')).toBeTruthy()
    expect(time('5:00 pm')).toBeTruthy()
    // Weekdays lit, weekend dark — the same five days the dashboard offers.
    expect(screen.getByTestId('week-summary-mon').dataset.active).toBe('true')
    expect(screen.getByTestId('week-summary-fri').dataset.active).toBe('true')
    expect(screen.getByTestId('week-summary-sat').dataset.active).toBe('false')
  })

  it('prefills the default for an entry whose schedules array is empty', () => {
    const { save } = setup([])

    expect(save()).toStrictEqual(WEB_AUTHORED_DEFAULT)
  })

  it('falls back to the default when the only block on disk is unusable', () => {
    // Hand-mangled: no `days`, no `ranges` — reading either would throw as
    // the dialog opens.
    const { save } = setup([{ name: 'nonsense' } as unknown as ScheduleBlock])

    expect(save()).toStrictEqual(WEB_AUTHORED_DEFAULT)
  })

  it('opens on what the web wrote, not on the default', () => {
    setup([{ days: ['sat', 'sun'], ranges: [{ start: '22:00', stop: '02:00' }] }])

    expect(time('10:00 pm')).toBeTruthy()
    expect(time('2:00 am')).toBeTruthy()
    expect(screen.getByTestId('week-summary-mon').dataset.active).toBe('false')
    expect(screen.getByTestId('week-summary-sat').dataset.active).toBe('true')
  })
})

describe('what gets written', () => {
  it('emits exactly the array the web writes for the default schedule', () => {
    const { save } = setup(null)

    // toStrictEqual: an invented `name: undefined` or an extra colour slot
    // would change the document this app writes.
    expect(save()).toStrictEqual(WEB_AUTHORED_DEFAULT)
  })

  it('hands a web-authored block back byte for byte when nothing is touched', () => {
    const { save } = setup(WEB_AUTHORED_COLOURED)

    expect(save()).toStrictEqual(WEB_AUTHORED_COLOURED)
  })

  it('carries fields it does not edit — name and colour slot — through a change', () => {
    const { save } = setup([
      {
        name: 'morning shift',
        colorIndex: 3,
        days: ['mon'],
        ranges: [{ start: '09:00', stop: '17:00' }],
      },
    ])

    // mouseDown, not click — pills toggle on press so a drag can extend the
    // selection.
    fireEvent.mouseDown(screen.getByTitle('tuesday'))

    expect(save()).toStrictEqual([
      {
        name: 'morning shift',
        colorIndex: 3,
        days: ['mon', 'tue'],
        ranges: [{ start: '09:00', stop: '17:00' }],
      },
    ])
  })

  it('writes a retyped time back in 24-hour form', () => {
    const { save } = setup(null)

    const start = time('9:00 am')
    fireEvent.focus(start)
    fireEvent.change(start, { target: { value: '7am' } })
    fireEvent.blur(start)

    expect(save()).toStrictEqual([
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '07:00', stop: '17:00' }] },
    ])
  })

  it('adds a block with the next unused colour slot', () => {
    const { save } = setup(null)

    fireEvent.click(screen.getByRole('button', { name: /add schedule block/ }))

    // The seeded block has no `colorIndex` but RENDERS slot 0 by position, so
    // the allocator must count 0 as taken (two-blue-blocks bug, 2026-08-13).
    expect(save()).toStrictEqual([
      ...WEB_AUTHORED_DEFAULT,
      {
        colorIndex: 1,
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        ranges: [{ start: '09:00', stop: '17:00' }],
      },
    ])
  })

  it('drops a block that can never match', () => {
    const { save } = setup([
      { days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] },
      { days: [], ranges: [{ start: '09:00', stop: '17:00' }] },
    ])

    expect(save()).toStrictEqual([{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }])
  })
})

describe('leaving the dialog', () => {
  it('writes nothing when it is cancelled', () => {
    const { onSave, onClose } = setup(null)

    const start = time('9:00 am')
    fireEvent.focus(start)
    fireEvent.change(start, { target: { value: '7am' } })
    fireEvent.blur(start)

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('writes nothing when it is dismissed with escape', () => {
    const { onSave, onClose } = setup(null)

    fireEvent.keyDown(screen.getByTestId('schedule-editor'), { key: 'Escape' })

    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes itself after a save', () => {
    const { onClose, save } = setup(null)

    save()

    expect(onClose).toHaveBeenCalledOnce()
  })
})
