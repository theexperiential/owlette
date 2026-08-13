import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusFooter } from '@/components/StatusFooter'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ServiceStatus } from '@/lib/ipc'
import type { OwletteConfig } from '@/lib/owletteConfig'
import type { ServiceStatusFile } from '@/lib/serviceHealth'

const healthy: ServiceStatus = {
  installed: true,
  running: true,
  state: 'running',
  startType: 'auto_start',
  statusFile: { exists: true, ageSecs: 12, stale: false },
}

const connected: ServiceStatusFile = {
  service: { running: true, last_update: 1_786_562_574, version: '3.0.0' },
  firebase: { enabled: true, connected: true, site_id: 'default_site', last_heartbeat: 0 },
  health: { status: 'ok', error_code: null, error_message: null },
}

const joined = { firebase: { enabled: true, site_id: 'default_site' } } as OwletteConfig

function setup(overrides: Partial<Parameters<typeof StatusFooter>[0]> = {}) {
  const props = {
    status: healthy,
    statusFile: connected,
    config: joined,
    starting: false,
    onStart: vi.fn(),
    ...overrides,
  }
  return render(
    <TooltipProvider>
      <StatusFooter {...props} />
    </TooltipProvider>,
  )
}

describe('StatusFooter sentence', () => {
  it('phrases the connected state as a sentence when the host is known', () => {
    setup({ hostname: 'TEC-A4D' })
    expect(screen.getByTestId('footer-status').textContent).toBe(
      'TEC-A4D is connected to default_site',
    )
  })

  it('falls back to the segment form while the host is unknown', () => {
    setup({ hostname: null })
    expect(screen.getByTestId('footer-status').textContent).toBe('connected · default_site')
  })

  it('shows the running service version on the right', () => {
    setup({ hostname: 'TEC-A4D' })
    expect(screen.getByText('v3.0.0')).toBeTruthy()
  })
})
