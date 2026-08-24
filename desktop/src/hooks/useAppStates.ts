import { useCallback, useEffect, useRef, useState } from 'react'
import { useOwletteFileWatch } from '@/hooks/useOwletteFileWatch'
import { OWLETTE_FILES, readOwletteJson, writeOwletteJson } from '@/lib/ipc'
import { parseAppStates, type AppStates } from '@/lib/processStatus'

export interface AppStatesStore {
  /** Live process table, keyed by OS pid. Empty until the service launches something. */
  states: AppStates
  error: string | null
  reload: () => void
  /**
   * Read straight from disk. Kill and restart resolve pids through this, not the cached copy — a
   * watcher event lags the service by milliseconds, and a recycled pid is how a UI kills the
   * wrong process.
   */
  read: () => Promise<AppStates>
  /** Read-modify-write the table — used only to stamp the operator's own markers. */
  mutate: (transform: (states: AppStates) => AppStates) => Promise<AppStates>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `tmp/app_states.json`, watched rather than polled — the service rewrites it on every state
 * change, which is what makes the dots live without a timer. A failed read (file being replaced
 * mid-look) keeps the last table; dropping to empty would blink every dot to inactive.
 */
export function useAppStates(): AppStatesStore {
  const [states, setStates] = useState<AppStates>({})
  const [error, setError] = useState<string | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const disposed = useRef(false)

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
    }
  }, [])

  const reload = useCallback(() => {
    void readOwletteJson(OWLETTE_FILES.appStates)
      .then((document) => {
        if (disposed.current) return
        setStates(parseAppStates(document))
        setError(null)
      })
      .catch((cause) => {
        if (disposed.current) return
        setError(message(cause))
      })
  }, [])

  useEffect(reload, [reload])
  useOwletteFileWatch('app_states', reload)

  const read = useCallback(async () => {
    const fresh = parseAppStates(await readOwletteJson(OWLETTE_FILES.appStates))
    if (!disposed.current) {
      setStates(fresh)
      setError(null)
    }
    return fresh
  }, [])

  const mutate = useCallback((transform: (states: AppStates) => AppStates) => {
    const run = queue.current.then(async () => {
      const fresh = parseAppStates(await readOwletteJson(OWLETTE_FILES.appStates))
      const next = transform(fresh)
      await writeOwletteJson(OWLETTE_FILES.appStates, next)
      if (!disposed.current) {
        setStates(next)
        setError(null)
      }
      return next
    })

    queue.current = run.catch(() => undefined)
    return run
  }, [])

  return { states, error, reload, read, mutate }
}
