import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessDetail } from '@/components/ProcessDetail'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ProcessEntry } from '@/lib/owletteConfig'

vi.mock('@/lib/pickers', () => ({
  pickExecutable: vi.fn(),
  pickFile: vi.fn(),
  pickDirectory: vi.fn(),
}))

const base: ProcessEntry = {
  id: 'a',
  name: 'player',
  exe_path: 'C:/apps/player.exe',
  file_path: '',
  cwd: '',
  priority: 'Normal',
  visibility: 'Normal',
  time_delay: '0',
  time_to_init: '10',
  relaunch_attempts: '5',
  launch_mode: 'off',
}

function setup(process: ProcessEntry = base) {
  const onSave = vi.fn()
  const onLaunchMode = vi.fn()

  function ui(entry: ProcessEntry) {
    return (
      <TooltipProvider>
        <ProcessDetail
          process={entry}
          status="INACTIVE"
          onSave={onSave}
          onLaunchMode={onLaunchMode}
          onPriority={vi.fn()}
          onVisibility={vi.fn()}
          onRestart={vi.fn()}
          onKill={vi.fn()}
        />
      </TooltipProvider>
    )
  }

  const view = render(ui(process))

  return { onSave, onLaunchMode, rerender: (next: ProcessEntry) => view.rerender(ui(next)) }
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

/** Focus, type, blur — one operator edit. */
function edit(input: HTMLInputElement, value: string) {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('auto-save', () => {
  it('writes a changed field on blur', () => {
    const { onSave } = setup()

    edit(field('name'), 'media player')

    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'media player', exe_path: 'C:/apps/player.exe' }),
    )
  })

  it('writes nothing when focus passes through a field untouched', () => {
    const { onSave } = setup()

    fireEvent.focus(field('name'))
    fireEvent.blur(field('name'))

    expect(onSave).not.toHaveBeenCalled()
  })

  it('writes nothing when the typed value is what is already on disk', () => {
    const { onSave } = setup()

    edit(field('name'), 'player')

    expect(onSave).not.toHaveBeenCalled()
  })

  it('folds the enter key and the blur it causes into one write', () => {
    const { onSave } = setup()
    const input = field('name')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'media player' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(onSave).toHaveBeenCalledOnce()
  })

  it('applies the service’s floors to a nonsense number rather than nagging', () => {
    const { onSave } = setup({ ...base, time_to_init: '30' })

    edit(field('wait (sec)'), '2')

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ time_to_init: '10' }))
    expect(field('wait (sec)').value).toBe('10')
  })

  it('stops showing a value the file will never hold', () => {
    const { onSave } = setup()

    // Floored to the ten seconds already stored, so there is nothing to write —
    // and nothing on screen should suggest otherwise.
    edit(field('wait (sec)'), '2')

    expect(onSave).not.toHaveBeenCalled()
    expect(field('wait (sec)').value).toBe('10')
  })

  it('refuses to save a nameless entry, and keeps what was typed', () => {
    const { onSave } = setup()

    edit(field('name'), '')

    expect(onSave).not.toHaveBeenCalled()
    expect(field('name').value).toBe('')
  })
})

describe('external changes', () => {
  it('takes a change made elsewhere when nothing is focused', () => {
    const { rerender } = setup()

    rerender({ ...base, name: 'renamed by the web app' })

    expect(field('name').value).toBe('renamed by the web app')
  })

  it('holds a change back while the operator is typing in that field', () => {
    const { rerender } = setup()
    const input = field('name')

    fireEvent.focus(input)
    rerender({ ...base, name: 'renamed by the web app' })

    expect(input.value).toBe('player')

    // …and applies it the moment focus leaves.
    fireEvent.blur(input)
    expect(field('name').value).toBe('renamed by the web app')
  })

  it('lets the operator’s own edit win over the change it raced', () => {
    const { onSave, rerender } = setup()
    const input = field('name')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'mine' } })
    rerender({ ...base, name: 'theirs' })
    fireEvent.blur(input)

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'mine' }))
    expect(field('name').value).toBe('mine')
  })

  it('adopts a different process wholesale, focus or not', () => {
    const { rerender } = setup()

    fireEvent.focus(field('name'))
    rerender({ ...base, id: 'b', name: 'other', exe_path: 'C:/apps/other.exe' })

    expect(field('name').value).toBe('other')
    expect(field('exe').value).toBe('C:/apps/other.exe')
  })
})

describe('the launch mode control', () => {
  function segment(label: string): HTMLButtonElement {
    return screen.getByRole('radio', { name: label }) as HTMLButtonElement
  }

  it('shows all three modes at once, with the current one checked', () => {
    setup()

    expect(screen.getByTestId('launch-mode').getAttribute('role')).toBe('radiogroup')
    expect(segment('off').getAttribute('aria-checked')).toBe('true')
    expect(segment('always on').getAttribute('aria-checked')).toBe('false')
    expect(segment('scheduled').getAttribute('aria-checked')).toBe('false')
  })

  it('asks for the mode of the segment that was clicked', () => {
    const { onLaunchMode } = setup()

    fireEvent.click(segment('always on'))

    expect(onLaunchMode).toHaveBeenCalledExactlyOnceWith('always')
  })

  it('does not ask again for the mode it is already in', () => {
    const { onLaunchMode } = setup({ ...base, launch_mode: 'scheduled' })

    fireEvent.click(segment('scheduled'))

    // The caller writes config.json for every call, and rewriting it identically
    // makes the service re-read and re-upload the config for nothing.
    expect(onLaunchMode).not.toHaveBeenCalled()
  })

  it('slides the fill to the segment the mode names', () => {
    const { rerender } = setup()
    const indicator = screen.getByTestId('launch-mode-indicator')

    expect(indicator.style.transform).toBe('translateX(0%)')

    rerender({ ...base, launch_mode: 'always' })
    expect(indicator.style.transform).toBe('translateX(100%)')
    expect(indicator.className).toContain('bg-emerald-600')

    rerender({ ...base, launch_mode: 'scheduled' })
    expect(indicator.style.transform).toBe('translateX(200%)')
    expect(indicator.className).toContain('bg-blue-600')
  })

  it('reads the legacy autolaunch flag when there is no launch mode', () => {
    setup({ ...base, launch_mode: undefined, autolaunch: true })

    expect(segment('always on').getAttribute('aria-checked')).toBe('true')
  })
})

describe('schedules', () => {
  it('points at the web app when a scheduled entry has no windows', () => {
    setup({ ...base, launch_mode: 'scheduled' })

    expect(screen.getByTestId('schedule-note').textContent).toBe(
      '(no schedule set — configure via web)',
    )
  })

  it('summarises the windows the web app authored', () => {
    setup({
      ...base,
      launch_mode: 'scheduled',
      schedules: [{ days: ['mon', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] }],
    })

    expect(screen.getByTestId('schedule-note').textContent).toBe('mon, fri: 09:00-17:00')
  })

  it('says nothing about schedules for an always-on entry', () => {
    setup({ ...base, launch_mode: 'always' })

    expect(screen.queryByTestId('schedule-note')).toBeNull()
  })
})
