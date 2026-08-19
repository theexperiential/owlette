import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@/lib/agentCli'

const startAgentRun = vi.fn()
const openExternalUrl = vi.fn()
const copyText = vi.fn()

vi.mock('@/lib/agentCli', () => ({
  startAgentRun: (...args: unknown[]) => startAgentRun(...args),
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}))
vi.mock('@/lib/clipboard', () => ({ copyText: (...args: unknown[]) => copyText(...args) }))

const { JoinSiteDialog } = await import('./JoinSiteDialog')

const PHRASE: AgentEvent = {
  event: 'phrase',
  value: {
    pairPhrase: 'silver-compass-drift',
    pairingUrl: 'https://dev.owlette.app/add?code=silver-compass-drift',
    verificationUri: 'https://dev.owlette.app/add',
    expiresIn: 600,
  },
}

function fakeRun() {
  let emit: (event: AgentEvent) => void = () => {}
  let finish: (outcome: { code: number | null; terminal: null; stderr: string }) => void = () => {}
  const cancel = vi.fn().mockResolvedValue(undefined)

  startAgentRun.mockImplementation((_mode: string, options: { onEvent?: (e: AgentEvent) => void }) => {
    emit = (event) => options.onEvent?.(event)
    return Promise.resolve({
      id: 'join-0',
      completed: new Promise((resolve) => {
        finish = resolve
      }),
      cancel,
    })
  })

  return {
    cancel,
    emit: (event: AgentEvent) => act(() => emit(event)),
    exit: async (code: number, stderr = '') => {
      await act(async () => {
        finish({ code, terminal: null, stderr })
        await Promise.resolve()
      })
    },
  }
}

async function open(props: Partial<Parameters<typeof JoinSiteDialog>[0]> = {}) {
  const all = { open: true, onClose: vi.fn(), onJoined: vi.fn(), ...props }
  const view = render(<JoinSiteDialog {...all} />)
  await act(async () => {
    await Promise.resolve()
  })
  return { ...all, view }
}

beforeEach(() => {
  startAgentRun.mockReset()
  openExternalUrl.mockReset().mockResolvedValue(undefined)
  copyText.mockReset().mockResolvedValue(true)
})

describe('JoinSiteDialog', () => {
  it('starts the pairing helper when it opens, and not before', async () => {
    fakeRun()
    render(<JoinSiteDialog open={false} onClose={vi.fn()} onJoined={vi.fn()} />)
    expect(startAgentRun).not.toHaveBeenCalled()

    await open()
    expect(startAgentRun).toHaveBeenCalledWith('join', expect.anything())
  })

  it('shows the phrase the helper streams back, then the status underneath it', async () => {
    const run = fakeRun()
    await open()

    expect(screen.getByTestId('join-phrase').textContent).toContain('…')

    run.emit(PHRASE)
    expect(screen.getByTestId('join-phrase').textContent).toContain('silver-compass-drift')
    expect(screen.getByText('click to copy')).not.toBeNull()

    run.emit({ event: 'status', value: 'waiting for authorization' })
    expect(screen.getByTestId('join-status').textContent).toContain('waiting for authorization')
  })

  it('copies the phrase on click — the helper never touches the clipboard', async () => {
    const run = fakeRun()
    await open()
    run.emit(PHRASE)

    fireEvent.click(screen.getByTestId('join-phrase'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(copyText).toHaveBeenCalledExactlyOnceWith('silver-compass-drift')
    expect(screen.getByText('copied to clipboard')).not.toBeNull()
  })

  it('opens the pairing page with the phrase pre-filled', async () => {
    const run = fakeRun()
    await open()
    run.emit(PHRASE)

    fireEvent.click(screen.getByRole('button', { name: /open owlette.app\/add/ }))
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
      'https://dev.owlette.app/add?code=silver-compass-drift',
    )
  })

  it('reports the site once authorization lands', async () => {
    const run = fakeRun()
    const props = await open()

    run.emit(PHRASE)
    run.emit({ event: 'authorized', value: { siteId: 'default_site', serviceRestarted: true } })

    expect(props.onJoined).toHaveBeenCalledExactlyOnceWith('default_site')
    expect(screen.getByTestId('join-status').textContent).toContain('the service is restarting')
  })

  it('tells the operator to restart the service when the helper could not', async () => {
    const run = fakeRun()
    await open()

    run.emit(PHRASE)
    // NSSM needs rights a standard user does not have; pairing still worked, so
    // the machine is one restart away from showing up rather than silently absent.
    run.emit({ event: 'authorized', value: { siteId: 'default_site', serviceRestarted: false } })

    expect(screen.getByTestId('join-status').textContent).toContain(
      'restart the service from the tray menu',
    )
  })

  it('kills the helper when the dialog closes — the code is left to expire', async () => {
    const run = fakeRun()
    const { view } = await open()

    view.rerender(<JoinSiteDialog open={false} onClose={vi.fn()} onJoined={vi.fn()} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(run.cancel).toHaveBeenCalled()
  })

  it('shows the helper\'s error rather than waiting forever', async () => {
    const run = fakeRun()
    await open()

    run.emit({ event: 'error', value: 'Pairing phrase expired.' })
    expect(screen.getByTestId('join-error').textContent).toContain('Pairing phrase expired.')
  })

  it('does not spin when the helper dies mid-protocol', async () => {
    const run = fakeRun()
    await open()

    await run.exit(1, 'ModuleNotFoundError: requests')
    expect(screen.getByTestId('join-error').textContent).toContain('ModuleNotFoundError')
  })

  it('surfaces a helper that could not be spawned at all', async () => {
    startAgentRun.mockRejectedValue(new Error('the bundled python interpreter is missing'))
    await open()

    expect(screen.getByTestId('join-error').textContent).toContain('python interpreter is missing')
  })
})
