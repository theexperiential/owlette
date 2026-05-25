const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

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
    return await fetch(input, { ...rest, signal });
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

