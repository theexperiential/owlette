import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runAgent = vi.fn()
vi.mock('@/lib/agentCli', () => ({ runAgent: (...args: unknown[]) => runAgent(...args) }))

const { RestartCountdown } = await import('./RestartCountdown')

function advance(seconds: number) {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000)
  })
}

/** Let the agent promise settle without letting the 1 s ticker run away. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}

function clock() {
  return screen.getByTestId('restart-remaining').textContent
}

beforeEach(() => {
  vi.useFakeTimers()
  runAgent.mockReset().mockResolvedValue({ code: 0, terminal: null, stderr: '' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RestartCountdown', () => {
  it('opens on two minutes and counts down once a second', () => {
    render(<RestartCountdown open onClose={vi.fn()} />)

    expect(clock()).toBe('2:00')
    advance(1)
    expect(clock()).toBe('1:59')
    advance(59)
    expect(clock()).toBe('1:00')
  })

  it('holds the clock while paused and resumes it afterwards', () => {
    render(<RestartCountdown open onClose={vi.fn()} />)

    advance(5)
    expect(clock()).toBe('1:55')

    fireEvent.click(screen.getByTestId('restart-pause'))
    advance(30)
    expect(clock()).toBe('1:55')
    expect(screen.getByText('countdown paused')).not.toBeNull()
    expect(runAgent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('restart-pause'))
    advance(2)
    expect(clock()).toBe('1:53')
  })

  it('reboots through the agent when the clock runs out, exactly once', () => {
    render(<RestartCountdown open onClose={vi.fn()} />)

    advance(119)
    expect(runAgent).not.toHaveBeenCalled()

    advance(1)
    expect(clock()).toBe('0:00')
    expect(runAgent).toHaveBeenCalledExactlyOnceWith('reboot-now')

    // Nothing may fire a second shutdown, whatever else re-renders.
    advance(10)
    expect(runAgent).toHaveBeenCalledOnce()
  })

  it('a held pause is a held reboot — the machine stays up', () => {
    render(<RestartCountdown open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('restart-pause'))
    advance(600)

    expect(clock()).toBe('2:00')
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('restart now reboots immediately', () => {
    render(<RestartCountdown open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'restart now' }))
    expect(runAgent).toHaveBeenCalledExactlyOnceWith('reboot-now')
  })

  it('cancel clears the pending reboot and closes', async () => {
    const onClose = vi.fn()
    render(<RestartCountdown open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    // The dashboard's own dismiss clears the same rebootPending field.
    expect(runAgent).toHaveBeenCalledExactlyOnceWith('dismiss-reboot')

    await settle()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('still closes when the flag could not be cleared — an offline machine is not trapped', async () => {
    const onClose = vi.fn()
    runAgent.mockRejectedValue(new Error('owlette is not authenticated with the cloud'))
    render(<RestartCountdown open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    await settle()

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the operator on screen when the reboot itself fails', async () => {
    const onClose = vi.fn()
    runAgent.mockRejectedValue(new Error('could not restart windows: Access is denied'))
    render(<RestartCountdown open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'restart now' }))
    await settle()

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('restart-error').textContent).toContain('Access is denied')
    // And they can try again.
    const retry = screen.getByRole('button', { name: 'restart now' }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
  })

  it('renders nothing until the service asks for it', () => {
    render(<RestartCountdown open={false} onClose={vi.fn()} />)
    expect(screen.queryByTestId('restart-countdown')).toBeNull()
  })
})
