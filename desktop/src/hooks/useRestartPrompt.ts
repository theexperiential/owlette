import { useCallback, useEffect, useState } from 'react'
import { ARG_RESTART_PROMPT, launchArgs, onSecondInstance } from '@/lib/ipc'

/**
 * Whether the service is asking for the reboot prompt.
 *
 * It asks by launching the app with `--restart-prompt`
 * (`owlette_service.reached_max_relaunch_attempts`, :2237-2241). Both routes in
 * have to be watched: the flag is on our own argv when this launch *is* the
 * request, and it arrives on `owlette://second-instance` when the app was
 * already running — the single-instance plugin folds the second launch into this
 * process rather than starting another one.
 */
export function useRestartPrompt(): { armed: boolean; dismiss: () => void } {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined

    void launchArgs()
      .then((argv) => {
        if (!disposed && argv.includes(ARG_RESTART_PROMPT)) setArmed(true)
      })
      .catch(() => {
        // No bridge (browser dev run) — nothing is asking for a reboot.
      })

    void onSecondInstance((payload) => {
      if (payload.argv.includes(ARG_RESTART_PROMPT)) setArmed(true)
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
  }, [])

  return { armed, dismiss: useCallback(() => setArmed(false), []) }
}
