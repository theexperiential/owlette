import { useCallback, useEffect, useRef, useState } from 'react'
import { useOwletteFileWatch } from '@/hooks/useOwletteFileWatch'
import { OWLETTE_FILES, readOwletteJson, writeOwletteJson } from '@/lib/ipc'
import type { OwletteConfig } from '@/lib/owletteConfig'

export interface ConfigStore {
  /** Last document read successfully, or null before the first read lands. */
  config: OwletteConfig | null
  /** Why the last read or write failed, if it did. Cleared by the next success. */
  error: string | null
  loading: boolean
  reload: () => void
  /**
   * Read-modify-write one change into `config.json`.
   *
   * The transform never sees this hook's cached copy: the document is re-read
   * from disk inside the mutation, so a change the service or the web app made
   * since the last watcher event is merged rather than overwritten. Mutations
   * are serialised — two overlapping read-modify-write cycles would silently
   * drop the first one's edit.
   */
  mutate: (transform: (config: OwletteConfig) => OwletteConfig) => Promise<OwletteConfig>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `config/config.json`, watched rather than polled.
 *
 * A failed read holds the previous document and reports the error. It must
 * never fall back to an empty object: the host errors on a torn or unparseable
 * file precisely so that a UI which writes back what it "read" cannot erase an
 * operator's process list.
 */
export function useOwletteConfig(): ConfigStore {
  const [config, setConfig] = useState<OwletteConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Serialises mutations. Rejections are swallowed on the chain (not on the
  // promise handed back to the caller) so one failed write cannot wedge every
  // write after it.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const disposed = useRef(false)

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
    }
  }, [])

  const reload = useCallback(() => {
    void readOwletteJson<OwletteConfig>(OWLETTE_FILES.config)
      .then((document) => {
        if (disposed.current) return
        setConfig(document)
        setError(null)
      })
      .catch((cause) => {
        if (disposed.current) return
        setError(message(cause))
      })
      .finally(() => {
        if (!disposed.current) setLoading(false)
      })
  }, [])

  useEffect(reload, [reload])
  useOwletteFileWatch('config', reload)

  const mutate = useCallback((transform: (config: OwletteConfig) => OwletteConfig) => {
    const run = queue.current.then(async () => {
      const fresh = await readOwletteJson<OwletteConfig>(OWLETTE_FILES.config)
      const next = transform(fresh)
      await writeOwletteJson(OWLETTE_FILES.config, next)
      if (!disposed.current) {
        setConfig(next)
        setError(null)
      }
      return next
    })

    queue.current = run.catch(() => undefined)
    return run
  }, [])

  return { config, error, loading, reload, mutate }
}
