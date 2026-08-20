/**
 * Low-level HTTP client behind every resource class in the node sdk. It
 * attaches auth + `Roost-Version` + an auto-generated `Idempotency-Key` on
 * mutating calls (so transparent retries can't duplicate writes), turns
 * problem+json bodies into typed `OwletteApiError`s, and delegates retry to
 * `./retry.ts` (5 attempts, exponential + jitter, 429 and 5xx only).
 *
 * Deliberately thin — it wraps `globalThis.fetch` and nothing else. Pass a
 * `fetch` override for proxy agents or custom DNS.
 */

import { randomUUID } from 'crypto';
import { retry, type RetryOptions } from './retry';
import { SDK_VERSION } from '../version';

export const DEFAULT_API_URL = 'https://owlette.app';
export const DEFAULT_ROOST_VERSION = '2026-04-22';

/** Advisory header the api sets while the account's free trial is running. */
const BILLING_WARNING_HEADER = 'x-owlette-billing-warning';

export type Environment = 'live' | 'test';

export interface OwletteClientOpts {
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
  /**
   * Called with the api's `X-Owlette-Billing-Warning` trial-countdown advisory.
   * Unset by default — the sdk never writes to its host's stderr on its own.
   *
   *   new Owlette({ token, onBillingWarning: (w) => logger.warn(w) })
   *
   * Fires once per response bearing the header, retries included, so
   * deduplicate if you want at-most-once. Throwing here is swallowed.
   */
  onBillingWarning?: (warning: string) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Omitted on POST/PATCH/PUT/DELETE, the client auto-generates
   * `node-sdk-<uuid>` so transparent retries stay safe.
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
export class OwletteApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly problem: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(status: number, problem: Record<string, unknown>) {
    const detail = typeof problem.detail === 'string' ? problem.detail : undefined;
    const title = typeof problem.title === 'string' ? problem.title : `http ${status}`;
    super(detail ?? title);
    this.name = 'OwletteApiError';
    this.status = status;
    this.code = typeof problem.code === 'string' ? problem.code : null;
    this.problem = problem;
    this.requestId =
      typeof problem.requestId === 'string' ? problem.requestId : null;
  }
}

export class OwletteClient {
  readonly apiUrl: string;
  readonly token: string;
  readonly roostVersion: string;
  readonly environment: Environment | null;
  readonly _fetch: typeof fetch;
  private readonly _retry: Partial<RetryOptions>;
  private readonly _onBillingWarning: ((warning: string) => void) | null;

  constructor(opts: OwletteClientOpts) {
    if (!opts.token || typeof opts.token !== 'string') {
      throw new TypeError('OwletteClient: `token` is required');
    }
    this.token = opts.token;
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.roostVersion = opts.roostVersion ?? DEFAULT_ROOST_VERSION;
    this.environment = opts.environment ?? null;
    this._fetch = opts.fetch ?? globalThis.fetch;
    this._retry = opts.retry ?? {};
    this._onBillingWarning = opts.onBillingWarning ?? null;
  }

  /**
   * Hand the trial advisory to the consumer's callback. A throwing callback
   * must never fail the request, so the error is swallowed.
   */
  private _emitBillingWarning(headers: Headers): void {
    if (!this._onBillingWarning) return;
    const warning = headers.get(BILLING_WARNING_HEADER);
    if (!warning) return;
    try {
      this._onBillingWarning(warning);
    } catch {
      /* consumer callback threw — never let it fail the request */
    }
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
      'User-Agent': `@owlette/sdk (node-sdk) ${SDK_VERSION}`,
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
      // Before the ok-check — the advisory matters on errors too.
      this._emitBillingWarning(res.headers);
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
        throw new OwletteApiError(res.status, problem);
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
