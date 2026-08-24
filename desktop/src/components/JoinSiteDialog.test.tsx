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

/** The same phrase, minted by production — the unbadged, unlabelled default. */
const PROD_PHRASE: AgentEvent = {
  event: 'phrase',
  value: {
    pairPhrase: 'silver-compass-drift',
    pairingUrl: 'https://owlette.app/add?code=silver-compass-drift',
    verificationUri: 'https://owlette.app/add',
    expiresIn: 600,
  },
}

/**
 * A phrase carrying no URLs at all: `parseAgentLine` defaults both fields to ''
 * when an older helper omits them, and the copy has to survive that.
 */
const HOSTLESS_PHRASE: AgentEvent = {
  event: 'phrase',
  value: { pairPhrase: 'silver-compass-drift', pairingUrl: '', verificationUri: '', expiresIn: 600 },
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

    // The label names the host the button actually opens. It used to say
    // `owlette.app/add` over a dev URL — the field bug this dialog now guards.
    fireEvent.click(screen.getByRole('button', { name: /open dev\.owlette\.app\/add/ }))
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

  it('does not demand a restart the operator does not need', async () => {
    const run = fakeRun()
    await open()

    run.emit(PHRASE)
    // The de-elevated app usually lacks SERVICE_STOP, so this is the normal
    // path — and it needs no restart: the running service re-reads the firebase
    // config every second main-loop iteration and reconnects on its own.
    run.emit({ event: 'authorized', value: { siteId: 'default_site', serviceRestarted: false } })

    expect(screen.getByTestId('join-status').textContent).toBe(
      'paired — this machine will appear on your dashboard shortly',
    )
  })

  it('drops the approve instruction once the machine is paired', async () => {
    const run = fakeRun()
    await open()

    run.emit(PHRASE)
    expect(screen.queryByText(/approve this machine at/)).not.toBeNull()

    run.emit({ event: 'authorized', value: { siteId: 'default_site', serviceRestarted: false } })

    // The stale next step is gone, replaced by where the machine actually went.
    expect(screen.queryByText(/approve this machine at/)).toBeNull()
    expect(screen.queryByText(/it will appear on your dashboard at/)).not.toBeNull()
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

  it('names the dev host in both the description and the button, and badges it', async () => {
    const run = fakeRun()
    await open()
    run.emit(PHRASE)

    expect(screen.getByTestId('join-site-dialog').textContent).toContain(
      'approve this machine at dev.owlette.app/add — from here or from any other device.',
    )
    expect(screen.getByTestId('join-environment').textContent).toBe('dev')
    expect(screen.getByRole('button', { name: /open dev\.owlette\.app\/add/ })).not.toBeNull()
  })

  it('names production plainly and badges nothing — an unbadged app is the real fleet', async () => {
    const run = fakeRun()
    await open()
    run.emit(PROD_PHRASE)

    expect(screen.getByTestId('join-site-dialog').textContent).toContain(
      'approve this machine at owlette.app/add — from here or from any other device.',
    )
    expect(screen.queryByTestId('join-environment')).toBeNull()
    expect(screen.getByRole('button', { name: /open owlette\.app\/add/ })).not.toBeNull()
  })

  it('names no host before a phrase exists rather than guessing one', async () => {
    fakeRun()
    await open()

    expect(screen.getByTestId('join-site-dialog').textContent).toContain(
      'approve this machine from here or from any other device.',
    )
    expect(screen.getByTestId('join-site-dialog').textContent).not.toContain('owlette.app/add')
    expect(screen.queryByTestId('join-environment')).toBeNull()
    expect(screen.queryByRole('button', { name: /owlette\.app/ })).toBeNull()
  })

  it('borrows the requested server for the copy while the phrase is still in flight', async () => {
    fakeRun()
    await open({ server: 'dev' })

    expect(screen.getByTestId('join-site-dialog').textContent).toContain(
      'approve this machine at dev.owlette.app/add',
    )
    expect(screen.getByTestId('join-environment').textContent).toBe('dev')
  })

  it('degrades the button label when the phrase carries no URL', async () => {
    const run = fakeRun()
    await open()
    run.emit(HOSTLESS_PHRASE)

    expect(screen.getByRole('button', { name: /open pairing page/ })).not.toBeNull()
    expect(screen.queryByTestId('join-environment')).toBeNull()
  })

  it('pairs against the server the installer asked for', async () => {
    fakeRun()
    await open({ server: 'dev' })

    expect(startAgentRun).toHaveBeenCalledWith('join', expect.objectContaining({ server: 'dev' }))
  })

  it('names no server when nothing asked for one — the config keeps its own', async () => {
    fakeRun()
    await open()

    const options = startAgentRun.mock.calls[0][1] as { server?: string }
    expect(options.server).toBeUndefined()
  })

  it('restarts the run when the server changes — a different cloud is a different phrase', async () => {
    const run = fakeRun()
    const { view } = await open({ server: 'dev' })
    expect(startAgentRun).toHaveBeenCalledTimes(1)

    view.rerender(<JoinSiteDialog open server="prod" onClose={vi.fn()} onJoined={vi.fn()} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(run.cancel).toHaveBeenCalled()
    expect(startAgentRun).toHaveBeenCalledTimes(2)
    expect(startAgentRun.mock.calls[1][1]).toEqual(expect.objectContaining({ server: 'prod' }))
  })
})
