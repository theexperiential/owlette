/**
 * Low-level HTTP client used by every resource class in the node sdk.
 *
 * Responsibilities kept tight on purpose:
 *   - attach `Authorization: Bearer owk_*` + `Roost-Version` + default
 *     `Idempotency-Key` on mutating calls (auto-generated per request
 *     so retries on transient failure don't create duplicate writes).
 *   - translate 4xx/5xx problem+json bodies into typed `RoostApiError`
 *     instances so callers can `instanceof`-check for specific codes.
 *   - delegate retry to `./retry.ts` with a sensible default schedule
 *     (5 attempts, exponential with jitter, only for 429 + 5xx).
 *
 * This is intentionally NOT a feature-rich http library — it wraps
 * `globalThis.fetch` and nothing else. Bring your own proxy agents /
 * custom DNS via a `fetch` override passed to the constructor if you
 * need them.
 */

import { randomUUID } from 'crypto';
import { retry, type RetryOptions } from './retry';

export const DEFAULT_API_URL = 'https://owlette.app';
export const DEFAULT_ROOST_VERSION = '2026-04-22';

export type Environment = 'live' | 'test';

export interface RoostClientOpts {
  /** Bearer token — `owk_live_*` or `owk_test_*`. */
  token: string;
  /** Override the api host. Default: https://owlette.app */
  apiUrl?: string;
  /** Overrides the `Roost-Version` header default. */
  roostVersion?: string;
  /** Propagated to audit + idempotency cache; set explicitly when the token's env is known. */
  environment?: Environment;
  /** Swap in a custom fetch (e.g. undici.fetch with a ProxyAgent). */
  fetch?: typeof fetch;
  /** Override the default retry schedule. */
  retry?: Partial<RetryOptions>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
     * Opt-in idempotency key. When omitted on POST/PATCH/PUT/DELETE, the client
   * auto-generates one of the form `node-sdk-<uuid>` so transparent retries
   * remain safe.
   */
  idempotencyKey?: string;
  /** Extra response headers to surface on the result object. */
  captureHeaders?: readonly string[];
  /** Skip retry entirely — used by long-lived streams. */
  noRetry?: boolean;
  /** Extra request headers to merge in. */
  headers?: Record<string, string>;
  /** Pass-through signal for cancellation. */
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

/** Typed error thrown by `request()` on non-2xx responses. */
export class RoostApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly problem: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(status: number, problem: Record<string, unknown>) {
    const detail = typeof problem.detail === 'string' ? problem.detail : undefined;
    const title = typeof problem.title === 'string' ? problem.title : `http ${status}`;
    super(detail ?? title);
    this.name = 'RoostApiError';
    this.status = status;
    this.code = typeof problem.code === 'string' ? problem.code : null;
    this.problem = problem;
    this.requestId =
      typeof problem.requestId === 'string' ? problem.requestId : null;
  }
}

export class RoostClient {
  readonly apiUrl: string;
  readonly token: string;
  readonly roostVersion: string;
  readonly environment: Environment | null;
  readonly _fetch: typeof fetch;
  private readonly _retry: Partial<RetryOptions>;

  constructor(opts: RoostClientOpts) {
    if (!opts.token || typeof opts.token !== 'string') {
      throw new TypeError('RoostClient: `token` is required');
    }
    this.token = opts.token;
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.roostVersion = opts.roostVersion ?? DEFAULT_ROOST_VERSION;
    this.environment = opts.environment ?? null;
    this._fetch = opts.fetch ?? globalThis.fetch;
    this._retry = opts.retry ?? {};
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const method = options.method ?? 'GET';
    const url = new URL(this.apiUrl + path);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Roost-Version': this.roostVersion,
      'User-Agent': '@owlette/sdk (node-sdk) 0.1.0',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };

    const isMutating =
      method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
    if (isMutating && !headers['Idempotency-Key'] && options.idempotencyKey !== '') {
      headers['Idempotency-Key'] = options.idempotencyKey ?? `node-sdk-${randomUUID()}`;
    }

    let bodyText: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] ??= 'application/json';
      bodyText = JSON.stringify(options.body);
    }

    const run = async (): Promise<ApiResponse<T>> => {
      const fetchInit: RequestInit = { method, headers };
      if (bodyText !== undefined) fetchInit.body = bodyText;
      if (options.signal) fetchInit.signal = options.signal;
      const res = await this._fetch(url.toString(), fetchInit);
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!res.ok) {
        const problem =
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : { detail: String(parsed ?? '') };
        throw new RoostApiError(res.status, problem);
      }

      const capturedHeaders: Record<string, string> = {};
      for (const name of options.captureHeaders ?? []) {
        const value = res.headers.get(name);
        if (value !== null) capturedHeaders[name] = value;
      }

      return {
        status: res.status,
        data: parsed as T,
        headers: capturedHeaders,
      };
    };

    if (options.noRetry) return run();
    return retry(run, this._retry);
  }
}
