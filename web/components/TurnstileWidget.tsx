'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

/**
 * Cloudflare Turnstile widget.
 *
 * Rendered explicitly (not via the `cf-turnstile` auto-scan class) so each
 * instance keeps its own widget id and can be reset. Turnstile tokens are
 * single-use: after a rejected submit the page stays mounted, so the stale
 * token must be cleared or the retry fails with `timeout-or-duplicate`.
 *
 * Inert when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is unset — renders nothing and
 * reports an empty token, which the server treats as "unconfigured" outside
 * production. That keeps `next dev` working without Turnstile credentials.
 *
 * CSP: the loader is injected programmatically by already-trusted (nonce-bearing)
 * React code, which `strict-dynamic` permits. The iframe still needs
 * `frame-src https://challenges.cloudflare.com` — see proxy.ts.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * Whether a sitekey is baked into this build.
 *
 * Forms use this to decide whether a token is REQUIRED before submit — without
 * it, a build with no sitekey would render no widget, never produce a token,
 * and leave the submit button permanently disabled. `NEXT_PUBLIC_*` is inlined
 * at build time, so this is a compile-time constant.
 */
export const TURNSTILE_ENABLED = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      theme?: 'light' | 'dark' | 'auto';
      callback?: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    }
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Allow a later mount to retry rather than caching the failure forever.
      scriptPromise = null;
      reject(new Error('failed to load turnstile'));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export interface TurnstileHandle {
  /** Clear the consumed token and request a fresh one. */
  reset: () => void;
}

interface TurnstileWidgetProps {
  /** Stable per-surface action, asserted server-side against siteverify. */
  action: 'register' | 'forgot-password';
  /** Receives the token, or '' when cleared/expired/errored. */
  onToken: (token: string) => void;
  className?: string;
}

export const TurnstileWidget = forwardRef<TurnstileHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ action, onToken, className }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const widgetIdRef = useRef<string | null>(null);
    // Keep the latest callback without re-rendering the widget when the parent
    // re-renders with a new closure. Synced in an effect, not during render —
    // mutating a ref while rendering is not safe under concurrent React.
    const onTokenRef = useRef(onToken);
    useEffect(() => {
      onTokenRef.current = onToken;
    }, [onToken]);

    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

    useImperativeHandle(
      ref,
      () => ({
        reset: () => {
          if (widgetIdRef.current && window.turnstile) {
            window.turnstile.reset(widgetIdRef.current);
            onTokenRef.current('');
          }
        },
      }),
      []
    );

    const emit = useCallback((token: string) => onTokenRef.current(token), []);

    useEffect(() => {
      if (!siteKey) return;

      let cancelled = false;

      loadTurnstileScript()
        .then(() => {
          if (cancelled || !containerRef.current || !window.turnstile) return;
          // Guard against React 19 StrictMode double-invoking the effect.
          if (widgetIdRef.current) return;

          widgetIdRef.current = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            action,
            theme: 'auto',
            callback: emit,
            'expired-callback': () => emit(''),
            'error-callback': () => emit(''),
          });
        })
        .catch(() => {
          if (!cancelled) emit('');
        });

      return () => {
        cancelled = true;
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }
      };
    }, [siteKey, action, emit]);

    if (!siteKey) return null;

    return <div ref={containerRef} className={className} data-testid="turnstile-widget" />;
  }
);
