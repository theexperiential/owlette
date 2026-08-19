const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Advisory header the api attaches while the account's free trial is still
 * running. Lowercase because `Headers.get()` is case-insensitive and this is
 * the form we look it up by.
 */
const BILLING_WARNING_HEADER = 'x-owlette-billing-warning';

/**
 * Latch so the trial advisory prints **once per process invocation**, not
 * once per request. A command that pages through ten requests (`roost list`,
 * `push`, `deploy --wait`) would otherwise repeat the same line ten times.
 */
let billingWarningPrinted = false;

/**
 * Print the api's trial-countdown advisory to stderr, at most once per
 * process. No-op when the response carries no warning — which is the case
 * for every subscribed account, so the steady state is silent.
 *
 * stderr, never stdout: `--json` output must stay pipeable into `jq`.
 *
 * Called for you by {@link fetchWithTimeout}; exported for the two long-lived
 * streaming call sites (`chat`, `listen`) that deliberately use a bare
 * `fetch` because a 30s timeout signal would sever the stream.
 */
export function noteBillingWarning(response: { headers: Headers }): void {
  if (billingWarningPrinted) return;
  const warning = response.headers.get(BILLING_WARNING_HEADER);
  if (!warning) return;
  billingWarningPrinted = true;
  process.stderr.write(`owlette: ${warning}\n`);
}

export interface FetchWithTimeoutInit extends RequestInit {
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: FetchWithTimeoutInit = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal: callerSignal, ...rest } = init;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetch(input, { ...rest, signal });
    noteBillingWarning(response);
    return response;
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

