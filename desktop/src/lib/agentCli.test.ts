import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const listen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }))

const {
  isTerminal,
  openExternalUrl,
  openOwlettePath,
  parseAgentLine,
  runAgent,
  startAgentRun,
} = await import('./agentCli')

interface HostLine {
  run: string
  stream: 'stdout' | 'stderr' | 'exit'
  line: string | null
  code: number | null
}

/** The handler the host registered, so a test can play the child's output. */
function host() {
  const handler = listen.mock.calls.at(-1)?.[1] as (event: { payload: HostLine }) => void
  return {
    stdout: (run: string, line: string) => handler({ payload: { run, stream: 'stdout', line, code: null } }),
    stderr: (run: string, line: string) => handler({ payload: { run, stream: 'stderr', line, code: null } }),
    exit: (run: string, code: number | null) =>
      handler({ payload: { run, stream: 'exit', line: null, code } }),
  }
}

const unlisten = vi.fn()

beforeEach(() => {
  invoke.mockReset()
  listen.mockReset()
  unlisten.mockReset()
  listen.mockResolvedValue(unlisten)
})

describe('parseAgentLine', () => {
  it('reads each event the python helper emits', () => {
    expect(
      parseAgentLine(
        '{"event":"phrase","value":{"pairPhrase":"silver-compass-drift","pairingUrl":"https://dev.owlette.app/add?code=silver-compass-drift","verificationUri":"https://dev.owlette.app/add","expiresIn":600}}',
      ),
    ).toEqual({
      event: 'phrase',
      value: {
        pairPhrase: 'silver-compass-drift',
        pairingUrl: 'https://dev.owlette.app/add?code=silver-compass-drift',
        verificationUri: 'https://dev.owlette.app/add',
        expiresIn: 600,
      },
    })

    expect(parseAgentLine('{"event":"status","value":"waiting for authorization"}')).toEqual({
      event: 'status',
      value: 'waiting for authorization',
    })
    expect(
      parseAgentLine(
        '{"event":"authorized","value":{"siteId":"default_site","serviceRestarted":true}}',
      ),
    ).toEqual({
      event: 'authorized',
      value: { siteId: 'default_site', serviceRestarted: true },
    })
    // A helper that could not restart the service says so; the dialog turns
    // that into an instruction rather than a silent half-success.
    expect(
      parseAgentLine(
        '{"event":"authorized","value":{"siteId":"s","serviceRestarted":false}}',
      ),
    ).toEqual({ event: 'authorized', value: { siteId: 's', serviceRestarted: false } })
    expect(parseAgentLine('{"event":"done","value":{"deregistered":true}}')).toEqual({
      event: 'done',
      value: { deregistered: true },
    })
    expect(parseAgentLine('{"event":"error","value":"phrase expired"}')).toEqual({
      event: 'error',
      value: 'phrase expired',
    })
  })

  it('ignores anything that is not one of our events', () => {
    for (const line of [
      '',
      '   ',
      'DeprecationWarning: ssl module is deprecated',
      '{ not json',
      '[]',
      '"a string"',
      '{"event":"something-else","value":1}',
      // A phrase with no phrase in it is not a phrase.
      '{"event":"phrase","value":{}}',
      '{"event":"phrase","value":null}',
      '{"event":"status","value":{"nested":true}}',
    ]) {
      expect(parseAgentLine(line), line).toBeNull()
    }
  })

  it('fills in the optional halves of a phrase rather than dropping it', () => {
    const parsed = parseAgentLine('{"event":"phrase","value":{"pairPhrase":"a-b-c"}}')
    expect(parsed).toEqual({
      event: 'phrase',
      value: { pairPhrase: 'a-b-c', pairingUrl: '', verificationUri: '', expiresIn: 600 },
    })
  })

  it('knows which events end a run', () => {
    expect(isTerminal({ event: 'status', value: 'x' })).toBe(false)
    expect(isTerminal({ event: 'phrase', value: { pairPhrase: 'a', pairingUrl: '', verificationUri: '', expiresIn: 1 } })).toBe(false)
    expect(isTerminal({ event: 'authorized', value: { siteId: 's', serviceRestarted: true } })).toBe(
      true,
    )
    expect(isTerminal({ event: 'done', value: {} })).toBe(true)
    expect(isTerminal({ event: 'error', value: 'x' })).toBe(true)
  })
})

describe('startAgentRun', () => {
  it('names the mode rather than a command line, and passes no payload by default', async () => {
    invoke.mockResolvedValue('join-0')
    await startAgentRun('join')

    expect(invoke).toHaveBeenCalledWith('agent_cli_start', {
      mode: 'join',
      payload: null,
      server: null,
    })
  })

  // `agent_cli_start` takes `server: Option<String>`, and the host turns a named
  // one into `--server dev|prod`. The key is always present so the argument is
  // an explicit "no server named" rather than a missing field.
  it('pairs against the server the caller named', async () => {
    invoke.mockResolvedValue('join-0')
    await startAgentRun('join', { server: 'dev' })

    expect(invoke).toHaveBeenCalledWith('agent_cli_start', {
      mode: 'join',
      payload: null,
      server: 'dev',
    })
  })

  it('names no server when the caller named none, leaving the config alone', async () => {
    invoke.mockResolvedValue('join-0')
    await startAgentRun('join')

    expect(invoke).toHaveBeenCalledWith('agent_cli_start', {
      mode: 'join',
      payload: null,
      server: null,
    })
  })

  it('names no server for the modes that never take one', async () => {
    invoke.mockResolvedValue('leave-0')
    await startAgentRun('leave')

    expect(invoke).toHaveBeenCalledWith('agent_cli_start', {
      mode: 'leave',
      payload: null,
      server: null,
    })
  })

  it('subscribes before spawning, so an early line is not lost', async () => {
    // The host emits its first status before `invoke` resolves the run id; the
    // buffer is what keeps the phrase dialog from missing it.
    let resolveStart: (id: string) => void = () => {}
    invoke.mockReturnValue(new Promise<string>((resolve) => (resolveStart = resolve)))

    const events: unknown[] = []
    const pending = startAgentRun('join', { onEvent: (event) => events.push(event) })

    await vi.waitFor(() => expect(listen).toHaveBeenCalled())
    host().stdout('join-0', '{"event":"status","value":"requesting a pairing phrase"}')
    expect(events).toEqual([])

    resolveStart('join-0')
    await pending

    expect(events).toEqual([{ event: 'status', value: 'requesting a pairing phrase' }])
  })

  it('ignores lines belonging to another run', async () => {
    invoke.mockResolvedValue('leave-3')
    const events: unknown[] = []
    await startAgentRun('leave', { onEvent: (event) => events.push(event) })

    host().stdout('join-1', '{"event":"status","value":"not ours"}')
    host().stdout('leave-3', '{"event":"status","value":"stopping the service"}')

    expect(events).toEqual([{ event: 'status', value: 'stopping the service' }])
  })

  it('resolves on exit with the terminal event and stops listening', async () => {
    invoke.mockResolvedValue('join-0')
    const run = await startAgentRun('join')

    host().stdout(
      'join-0',
      '{"event":"authorized","value":{"siteId":"default_site","serviceRestarted":true}}',
    )
    host().exit('join-0', 0)

    await expect(run.completed).resolves.toEqual({
      code: 0,
      terminal: {
        event: 'authorized',
        value: { siteId: 'default_site', serviceRestarted: true },
      },
      stderr: '',
    })
    expect(unlisten).toHaveBeenCalled()
  })

  it('collects stderr for a failure the protocol never explained', async () => {
    invoke.mockResolvedValue('join-0')
    const run = await startAgentRun('join')

    host().stderr('join-0', "ModuleNotFoundError: No module named 'requests'")
    host().exit('join-0', 1)

    const outcome = await run.completed
    expect(outcome.terminal).toBeNull()
    expect(outcome.code).toBe(1)
    expect(outcome.stderr).toContain('ModuleNotFoundError')
  })

  it('cancels by run id and survives a run that already exited', async () => {
    invoke.mockResolvedValue('join-0')
    const run = await startAgentRun('join')

    invoke.mockRejectedValueOnce('already gone')
    await expect(run.cancel()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenLastCalledWith('agent_cli_cancel', { run: 'join-0' })
  })

  it('stops listening when the spawn itself fails', async () => {
    invoke.mockRejectedValue('the bundled python interpreter is missing')

    await expect(startAgentRun('join')).rejects.toContain('python')
    expect(unlisten).toHaveBeenCalled()
  })
})

describe('runAgent', () => {
  it('resolves on a clean run', async () => {
    invoke.mockResolvedValue('leave-0')
    const pending = runAgent('leave')

    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    host().stdout('leave-0', '{"event":"done","value":{"deregistered":true}}')
    host().exit('leave-0', 0)

    await expect(pending).resolves.toMatchObject({ code: 0 })
  })

  it('rejects with the helper\'s own message', async () => {
    invoke.mockResolvedValue('leave-0')
    const pending = runAgent('leave')

    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    host().stdout('leave-0', '{"event":"error","value":"this machine is not paired with a site"}')
    host().exit('leave-0', 1)

    await expect(pending).rejects.toThrow('this machine is not paired with a site')
  })

  it('falls back to the stderr tail when the helper died mid-protocol', async () => {
    invoke.mockResolvedValue('report-issue-0')
    const pending = runAgent('report-issue', { payload: { category: 'bug', description: 'x' } })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(invoke).toHaveBeenCalledWith('agent_cli_start', {
      mode: 'report-issue',
      payload: { category: 'bug', description: 'x' },
      server: null,
    })

    host().stderr('report-issue-0', 'Traceback (most recent call last):')
    host().stderr('report-issue-0', 'OSError: [WinError 5] Access is denied')
    host().exit('report-issue-0', 1)

    await expect(pending).rejects.toThrow('WinError 5')
  })

  it('treats a terminal event with a non-zero exit as a failure', async () => {
    invoke.mockResolvedValue('leave-0')
    const pending = runAgent('leave')

    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    host().stdout('leave-0', '{"event":"done","value":{}}')
    host().exit('leave-0', 3)

    await expect(pending).rejects.toThrow('exited with code 3')
  })
})

describe('shell commands', () => {
  it('open paths and links by their own command names', async () => {
    invoke.mockResolvedValue(undefined)

    await openOwlettePath('config/config.json')
    await openExternalUrl('https://owlette.app/docs')

    expect(invoke.mock.calls).toEqual([
      ['open_owlette_path', { path: 'config/config.json' }],
      ['open_external_url', { url: 'https://owlette.app/docs' }],
    ])
  })
})
