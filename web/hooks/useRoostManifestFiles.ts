'use client';

/**
 * useRoostManifestFiles — lazy-fetch a roost version's file list. Fires only
 * when `enabled`, and caches by versionId so collapse/expand doesn't refetch.
 *
 * Goes through GET /api/roosts/{roostId}/versions/{versionId}/files rather than
 * hitting R2 directly: R2 sends no Access-Control-Allow-Origin on
 * private-bucket signed GETs, so a direct browser fetch is CORS-blocked.
 *
 * Name kept from before the rename; internals use `version` terminology to
 * match the routes.
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

// Keyed by versionId, which is content-addressed and therefore immutable — safe
// to reuse for the whole app session.
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
    // Page until nextPageToken is empty so the caller gets the full list;
    // the endpoint caps limit at 500.
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
    // Deterministic regardless of upload order, matching file-explorer default.
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
    // Sync-seed from cache so re-expanding doesn't flicker through loading.
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
