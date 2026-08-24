import { ARG_RESTART_PROMPT } from '@/lib/ipc'
import { useLaunchFlag } from '@/hooks/useLaunchFlag'

/**
 * Whether the service is asking for the reboot prompt.
 *
 * It asks by launching the app with `--restart-prompt`
 * (`owlette_service.reached_max_relaunch_attempts`, :2237-2241). Both routes in
 * have to be watched: the flag is on our own argv when this launch *is* the
 * request, and it arrives on `owlette://second-instance` when the app was
 * already running — the single-instance plugin folds the second launch into this
 * process rather than starting another one.
 *
 * Both routes are watched by {@link useLaunchFlag}; this only names the flag.
 */
export function useRestartPrompt(): { armed: boolean; dismiss: () => void } {
  const { armed, dismiss } = useLaunchFlag(ARG_RESTART_PROMPT)

  return { armed, dismiss }
}
