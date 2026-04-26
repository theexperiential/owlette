'use client';

/**
 * useRoostManifestFiles — lazy-fetch the file list for a roost's current
 * version. Only fires the network request when `enabled=true`, and
 * caches results in a module-level map keyed by versionId so
 * collapse/expand cycles don't refetch.
 *
 * Calls GET /api/roosts/{roostId}/versions/{versionId}/files — a
 * server-side proxy that fetches the version body from R2 and returns
 * just the file list. Proxying through our API avoids the CORS issue
 * the browser hits when fetching R2 signed URLs directly (R2 doesn't
 * send Access-Control-Allow-Origin on private-bucket signed GETs).
 *
 * The file is named `useRoostManifestFiles` for stability across the
 * rename — the internals all use `version` terminology, matching the
 * routes + the rest of the codebase.
 */

import { useEffect, useRef, useState } from 'react';

export interface VersionFile {
  path: string;
  size: number;
}

interface VersionFilesResult {
  files: readonly VersionFile[];
  loading: boolean;
  error: string | null;
}

// Cache keyed by versionId (content-addressed — sha256 of the version
// body, so immutable forever). A given version never changes, so cache
// entries are safe to reuse across the whole app session.
const cache = new Map<string, readonly VersionFile[]>();
const inflight = new Map<string, Promise<readonly VersionFile[]>>();

async function fetchVersionFiles(
  siteId: string,
  roostId: string,
  versionId: string,
): Promise<readonly VersionFile[]> {
  const cached = cache.get(versionId);
  if (cached) return cached;
  const existing = inflight.get(versionId);
  if (existing) return existing;

  const p = (async () => {
    // Server-side proxy — avoids R2's missing CORS headers on signed URLs.
    // The endpoint supports pagination via limit + cursor; we page through
    // until nextPageToken is empty so the caller gets the full list.
    // max limit is 500 per request.
    const collected: VersionFile[] = [];
    let cursor = '';
    while (true) {
      const qs = new URLSearchParams({
        siteId,
        limit: '500',
      });
      if (cursor) qs.set('cursor', cursor);
      const res = await fetch(
        `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(versionId)}/files?${qs}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? body.title ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        files?: Array<{ path?: unknown; size?: unknown }>;
        nextPageToken?: string;
      };
      for (const f of body.files ?? []) {
        if (typeof f.path === 'string' && typeof f.size === 'number') {
          collected.push({ path: f.path, size: f.size });
        }
      }
      cursor = body.nextPageToken ?? '';
      if (!cursor) break;
    }
    // Sort alphabetically by path so the list is deterministic
    // regardless of upload order. Mirrors how file explorers default.
    collected.sort((a, b) => a.path.localeCompare(b.path));
    Object.freeze(collected);
    cache.set(versionId, collected);
    return collected as readonly VersionFile[];
  })();
  inflight.set(versionId, p);
  try {
    return await p;
  } finally {
    inflight.delete(versionId);
  }
}

export function useRoostManifestFiles(
  siteId: string,
  roostId: string,
  versionId: string | null,
  enabled: boolean,
): VersionFilesResult {
  const [result, setResult] = useState<VersionFilesResult>(() => {
    // Sync-seed from cache on mount if the version was already fetched
    // in a prior expand — avoids a loading flicker on re-expand.
    const seeded = versionId ? cache.get(versionId) : null;
    return {
      files: seeded ?? [],
      loading: enabled && !seeded && !!versionId,
      error: null,
    };
  });
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !versionId || !siteId || !roostId) return;
    let cancelled = false;
    const cached = cache.get(versionId);
    if (cached) {
      queueMicrotask(() => {
        if (!cancelled && aliveRef.current) {
          setResult({ files: cached, loading: false, error: null });
        }
      });
      return () => {
        cancelled = true;
      };
    }
    queueMicrotask(() => {
      if (!cancelled && aliveRef.current) {
        setResult((prev) => ({ ...prev, loading: true, error: null }));
      }
    });
    fetchVersionFiles(siteId, roostId, versionId)
      .then((files) => {
        if (cancelled || !aliveRef.current) return;
        setResult({ files, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (cancelled || !aliveRef.current) return;
        setResult({ files: [], loading: false, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, siteId, roostId, versionId]);

  return result;
}
