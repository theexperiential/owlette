import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@/lib/agentCli'

const startAgentRun = vi.fn()
vi.mock('@/lib/agentCli', () => ({
  startAgentRun: (...args: unknown[]) => startAgentRun(...args),
}))

const { LeaveSiteDialog } = await import('./LeaveSiteDialog')

/** A controllable stand-in for a live helper run. */
function fakeRun() {
  let emit: (event: AgentEvent) => void = () => {}
  let finish: (outcome: { code: number | null; terminal: null; stderr: string }) => void = () => {}

  startAgentRun.mockImplementation((_mode: string, options: { onEvent?: (e: AgentEvent) => void }) => {
    emit = (event) => options.onEvent?.(event)
    return Promise.resolve({
      id: 'leave-0',
      completed: new Promise((resolve) => {
        finish = resolve
      }),
      cancel: vi.fn(),
    })
  })

  return {
    emit: (event: AgentEvent) => act(() => emit(event)),
    exit: async (code: number, stderr = '') => {
      await act(async () => {
        finish({ code, terminal: null, stderr })
        await Promise.resolve()
      })
    },
  }
}

function open(props: Partial<Parameters<typeof LeaveSiteDialog>[0]> = {}) {
  const all = {
    open: true,
    siteId: 'default_site',
    onClose: vi.fn(),
    onLeft: vi.fn(),
    ...props,
  }
  render(<LeaveSiteDialog {...all} />)
  return all
}

beforeEach(() => {
  startAgentRun.mockReset()
})

describe('LeaveSiteDialog', () => {
  it('asks before doing anything, naming the site', () => {
    open()

    expect(screen.getByTestId('leave-site-dialog').textContent).toContain('default_site')
    expect(startAgentRun).not.toHaveBeenCalled()
  })

  it('backs out without touching the agent', () => {
    const props = open()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(startAgentRun).not.toHaveBeenCalled()
  })

  it('runs the leave mode and shows each step as the agent reports it', async () => {
    const run = fakeRun()
    open()

    fireEvent.click(screen.getByRole('button', { name: 'leave site' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(startAgentRun).toHaveBeenCalledWith('leave', expect.anything())

    run.emit({ event: 'status', value: 'stopping the service' })
    expect(screen.getByTestId('leave-status').textContent).toContain('stopping the service')

    run.emit({ event: 'status', value: 'deregistering this machine' })
    expect(screen.getByTestId('leave-status').textContent).toContain('deregistering this machine')
  })

  it('cannot be dismissed while the service is being restarted', async () => {
    const run = fakeRun()
    const props = open()

    fireEvent.click(screen.getByRole('button', { name: 'leave site' }))
    await act(async () => {
      await Promise.resolve()
    })
    run.emit({ event: 'status', value: 'stopping the service' })

    const close = screen.getByRole('button', { name: 'close' }) as HTMLButtonElement
    expect(close.disabled).toBe(true)
    fireEvent.keyDown(screen.getByTestId('leave-site-dialog'), { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('reports success once the machine is deregistered', async () => {
    const run = fakeRun()
    const props = open()

    fireEvent.click(screen.getByRole('button', { name: 'leave site' }))
    await act(async () => {
      await Promise.resolve()
    })
    run.emit({ event: 'done', value: { siteId: 'default_site', deregistered: true } })

    expect(props.onLeft).toHaveBeenCalledOnce()
    expect(screen.getByTestId('leave-site-dialog').textContent).toContain('no longer monitored')
  })

  it('says so when the local half worked but the dashboard row survived', async () => {
    const run = fakeRun()
    open()

    fireEvent.click(screen.getByRole('button', { name: 'leave site' }))
    await act(async () => {
      await Promise.resolve()
    })
    run.emit({ event: 'done', value: { siteId: 'default_site', deregistered: false } })

    expect(screen.getByTestId('leave-site-dialog').textContent).toContain(
      'delete it from the dashboard',
    )
  })

  it('surfaces the agent\'s error', async () => {
    const run = fakeRun()
    open()

    fireEvent.click(screen.getByRole('button', { name: 'leave site' }))
    await act(async () => {
      await Promise.resolve()
    })
    run.emit({ event: 'error', value: 'this machine is not paired with a site' })

    expect(screen.getByTestId('leave-error').textContent).toContain('not paired with a site')
  })

  it('falls back to stderr when the helper dies without saying why', async () => {
    const run = fakeRun()
    open()

    fireEvent.click(screen.getByRole('button', { name: 'leave site' }))
    await act(async () => {
      await Promise.resolve()
    })
    await run.exit(1, 'ImportError: no module named auth_manager')

    expect(screen.getByTestId('leave-error').textContent).toContain('ImportError')
  })
})
