import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runAgent = vi.fn()
const toastSuccess = vi.fn()

vi.mock('@/lib/agentCli', () => ({ runAgent: (...args: unknown[]) => runAgent(...args) }))
vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args) },
}))

const { MAX_DESCRIPTION, ReportIssueDialog } = await import('./ReportIssueDialog')

function open(props: Partial<Parameters<typeof ReportIssueDialog>[0]> = {}) {
  const all = { open: true, onClose: vi.fn(), ...props }
  render(<ReportIssueDialog {...all} />)
  return all
}

function describeIssue(text: string) {
  fireEvent.change(screen.getByTestId('report-description'), { target: { value: text } })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  runAgent.mockReset().mockResolvedValue({ code: 0, terminal: null, stderr: '' })
  toastSuccess.mockReset()
})

describe('ReportIssueDialog', () => {
  it('cannot be submitted empty', () => {
    open()
    const submit = screen.getByRole('button', { name: 'submit' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    describeIssue('   ')
    expect((screen.getByRole('button', { name: 'submit' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends the category and description to the agent, trimmed', async () => {
    const props = open()
    describeIssue('  touchdesigner keeps dying overnight  ')

    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await flush()

    expect(runAgent).toHaveBeenCalledExactlyOnceWith('report-issue', {
      payload: { category: 'bug', description: 'touchdesigner keeps dying overnight' },
    })
    expect(toastSuccess).toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('counts down to the legacy dialog\'s limit and holds the line there', () => {
    open()
    expect(screen.getByTestId('report-remaining').textContent).toBe(
      `${MAX_DESCRIPTION} characters left`,
    )

    describeIssue('x'.repeat(MAX_DESCRIPTION + 500))
    expect(screen.getByTestId('report-remaining').textContent).toBe('0 characters left')
    expect(MAX_DESCRIPTION).toBe(1000)
  })

  it('keeps the operator\'s text when the submission fails', async () => {
    const props = open()
    runAgent.mockRejectedValue(new Error('owlette is not connected to a site'))

    describeIssue('the wall is black')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await flush()

    expect(screen.getByTestId('report-error').textContent).toContain('not connected to a site')
    expect(props.onClose).not.toHaveBeenCalled()
    expect((screen.getByTestId('report-description') as HTMLTextAreaElement).value).toBe(
      'the wall is black',
    )
  })

  it('starts clean every time it opens', () => {
    // The app keeps this mounted and flips `open`, so a second visit must not
    // show the last report's text.
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    describeIssue('first attempt')

    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)
    view.rerender(<ReportIssueDialog open onClose={onClose} />)

    expect((screen.getByTestId('report-description') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByTestId('report-remaining').textContent).toBe(
      `${MAX_DESCRIPTION} characters left`,
    )
  })
})
