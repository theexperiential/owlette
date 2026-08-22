import { useCallback, useEffect, useState } from 'react'
import { launchArgs, onSecondInstance } from '@/lib/ipc'

/** Stable identity, so dismissing an already-dismissed flag re-renders nothing. */
const NO_ARGV: string[] = []

/**
 * Whether the app was launched with `flag`, by either route in.
 *
 * The flag is on our own argv when this launch *is* the request, and it arrives
 * on `owlette://second-instance` when the app was already running — the
 * single-instance plugin folds the second launch into this process rather than
 * starting another one. Both have to be watched.
 */
export function useLaunchFlag(flag: string): {
  /** True once `flag` has been seen on either route. */
  armed: boolean
  /** argv of the launch that armed it; empty until then. */
  argv: string[]
  /** Disarm. Also clears `argv`, so a later re-open cannot re-read a stale flag. */
  dismiss: () => void
} {
  const [argv, setArgv] = useState<string[]>(NO_ARGV)

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined

    void launchArgs()
      .then((own) => {
        if (!disposed && own.includes(flag)) setArgv(own)
      })
      .catch(() => {
        // No bridge (browser dev run) — nothing is asking.
      })

    void onSecondInstance((payload) => {
      if (payload.argv.includes(flag)) setArgv(payload.argv)
    })
      .then((unlisten) => {
        if (disposed) unlisten()
        else stop = unlisten
      })
      .catch(() => {})

    return () => {
      disposed = true
      stop?.()
    }
  }, [flag])

  return { armed: argv.length > 0, argv, dismiss: useCallback(() => setArgv(NO_ARGV), []) }
}
