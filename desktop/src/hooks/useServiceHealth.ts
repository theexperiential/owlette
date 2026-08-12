import { useCallback, useEffect, useRef, useState } from 'react'
import { useOwletteFileWatch } from '@/hooks/useOwletteFileWatch'
import {
  OWLETTE_FILES,
  readOwletteJson,
  serviceStart,
  serviceStatus,
  type ServiceStatus,
} from '@/lib/ipc'
import type { ServiceStatusFile } from '@/lib/serviceHealth'

/**
 * How often the SCM is re-queried.
 *
 * The one timer in this app, and it is not a substitute for the watchers: when
 * the service dies it stops writing `service_status.json`, so there are no more
 * events to react to and the only way to notice the file going stale — the
 * two-minute rule the tray uses — is to ask again. An SCM query is a handful of
 * microseconds and never touches the seam files.
 */
const SCM_REFRESH_MS = 15_000

/** When a start is requested, when to look for the result. */
const START_CONFIRM_DELAYS_MS = [2_000, 6_000]

export interface ServiceHealthStore {
  status: ServiceStatus | null
  statusFile: ServiceStatusFile | null
  /** True while a start request is in flight (it may be waiting on a UAC prompt). */
  starting: boolean
  error: string | null
  refresh: () => void
  start: () => Promise<void>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `OwletteService`'s state, and the status file it publishes.
 *
 * On launch, a service that is installed but stopped is started — the app is
 * the operator's window onto a machine that is supposed to be supervised, and
 * opening it is as clear a signal as there is that they want it running. An
 * uninstalled service is left alone: there is nothing to start.
 */
export function useServiceHealth(): ServiceHealthStore {
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [statusFile, setStatusFile] = useState<ServiceStatusFile | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disposed = useRef(false)
  const autoStarted = useRef(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    disposed.current = false
    const pending = timers.current
    return () => {
      disposed.current = true
      pending.forEach(clearTimeout)
      pending.length = 0
    }
  }, [])

  const readStatusFile = useCallback(() => {
    void readOwletteJson<ServiceStatusFile>(OWLETTE_FILES.serviceStatus)
      .then((document) => {
        if (!disposed.current) setStatusFile(document)
      })
      .catch(() => {
        // A torn read here is transient and harmless — the footer keeps showing
        // the last good state until the next event, exactly like the tray does.
      })
  }, [])

  const queryScm = useCallback(() => {
    void serviceStatus()
      .then((next) => {
        if (!disposed.current) setStatus(next)
      })
      .catch((cause) => {
        if (!disposed.current) setError(message(cause))
      })
  }, [])

  const refresh = useCallback(() => {
    queryScm()
    readStatusFile()
  }, [queryScm, readStatusFile])

  const start = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      await serviceStart()
      // An elevated start only confirms the shell accepted the request, so the
      // result has to be observed rather than assumed.
      START_CONFIRM_DELAYS_MS.forEach((delay) => {
        timers.current.push(setTimeout(() => refresh(), delay))
      })
    } catch (cause) {
      if (!disposed.current) setError(message(cause))
    } finally {
      if (!disposed.current) setStarting(false)
    }
  }, [refresh])

  useEffect(refresh, [refresh])
  useOwletteFileWatch('service_status', refresh)

  useEffect(() => {
    const timer = setInterval(queryScm, SCM_REFRESH_MS)
    return () => clearInterval(timer)
  }, [queryScm])

  // Auto-start, once, on the first status that says it is needed.
  useEffect(() => {
    if (autoStarted.current || !status) return
    if (!status.installed || status.running || status.state === 'start_pending') return
    autoStarted.current = true
    void start()
  }, [status, start])

  return { status, statusFile, starting, error, refresh, start }
}
