import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DropConfirm } from '@/components/DropConfirm'
import type { ProcessEntryDraft } from '@/lib/dropClassifier'
import type { DropCard } from '@/lib/dropQueue'

vi.mock('@/lib/pickers', () => ({
  pickExecutable: vi.fn(),
  pickFile: vi.fn(),
  pickDirectory: vi.fn(),
}))

const entry: ProcessEntryDraft = {
  name: 'orientation',
  exe_path: 'C:\\Program Files\\Derivative\\TouchDesigner.2025.30060\\bin\\TouchDesigner.exe',
  file_path: 'C:\\shows\\Orientation.toe',
  cwd: 'C:\\shows',
  priority: 'Normal',
  visibility: 'Normal',
  time_delay: '0',
  time_to_init: '10',
  relaunch_attempts: '5',
  launch_mode: 'off',
  autolaunch: false,
  schedules: null,
}

const card: DropCard = {
  kind: 'touchdesigner',
  path: 'C:\\shows\\Orientation.toe',
  entry,
  needsInput: [],
  warnings: [],
}

function setup(overrides: Partial<Parameters<typeof DropConfirm>[0]> = {}) {
  const props = {
    card,
    remaining: 1,
    blockedReason: null,
    onChange: vi.fn(),
    onConfirm: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  }

  render(<DropConfirm {...props} />)
  return props
}

describe('the card', () => {
  it('shows what the drop was read as, and what it derived', () => {
    setup()

    expect(screen.getByText(/touchdesigner project/)).toBeTruthy()
    expect(screen.getByText(entry.exe_path)).toBeTruthy()
    expect(screen.getByText(entry.file_path)).toBeTruthy()
    expect(screen.getByText(entry.cwd)).toBeTruthy()
  })

  it('is closed when there is nothing to review', () => {
    setup({ card: null })

    expect(screen.queryByTestId('drop-confirm')).toBeNull()
  })

  it('says how many more files are waiting', () => {
    setup({ remaining: 3 })

    expect(screen.getByTestId('drop-remaining').textContent).toContain('2 more files are waiting')
  })

  it('says nothing about a queue of one', () => {
    setup()

    expect(screen.queryByTestId('drop-remaining')).toBeNull()
  })

  it('shows the classifier’s warnings', () => {
    setup({ card: { ...card, warnings: ['powershell mishandles a script path containing spaces'] } })

    expect(screen.getByTestId('drop-warning').textContent).toContain('powershell mishandles')
  })
})

describe('editing before it is written', () => {
  it('reports a rename', () => {
    const { onChange } = setup()

    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'lobby wall' } })

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ name: 'lobby wall' })
  })

  it('asks for an executable only when the classifier could not find one', () => {
    setup()
    expect(screen.queryByLabelText('exe')).toBeNull()

    render(
      <DropConfirm
        card={{ ...card, entry: { ...entry, exe_path: '' }, needsInput: ['exe_path'] }}
        remaining={1}
        blockedReason={null}
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        onSkip={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('exe')).toBeTruthy()
  })

  it('adds on enter, the way the rest of the app saves', () => {
    const { onConfirm } = setup()

    fireEvent.keyDown(screen.getByLabelText('name'), { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledOnce()
  })
})

describe('what it refuses to write', () => {
  it('shows the reason and disables the button', () => {
    setup({ blockedReason: 'a process named orientation already exists on this machine' })

    expect(screen.getByRole('alert').textContent).toContain('already exists')
    expect(screen.getByRole('button', { name: 'add process' }).hasAttribute('disabled')).toBe(true)
  })

  it('will not add on enter either', () => {
    const { onConfirm } = setup({ blockedReason: 'a name is required' })

    fireEvent.keyDown(screen.getByLabelText('name'), { key: 'Enter' })

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('skips the card without writing anything', () => {
    const { onSkip, onConfirm } = setup()

    fireEvent.click(screen.getByRole('button', { name: 'skip' }))

    expect(onSkip).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
