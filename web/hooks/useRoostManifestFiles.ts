'use client';

/**
 * useRoostManifestFiles — lazy-fetch the file list for a roost's current
 * manifest. Only fires the network request when `enabled=true`, and
 * caches results in a module-level map keyed by manifestId so
 * collapse/expand cycles don't refetch.
 *
 * Calls GET /api/roosts/{roostId}/manifests/{manifestId}/files — a
 * server-side proxy that fetches the manifest from R2 and returns just
 * the file list. Proxying through our API avoids the CORS issue the
 * browser hits when fetching R2 signed URLs directly (R2 doesn't send
 * Access-Control-Allow-Origin on private-bucket signed GETs).
 */

import { useEffect, useRef, useState } from 'react';

export interface ManifestFile {
  path: string;
  size: number;
}

interface ManifestFilesResult {
  files: readonly ManifestFile[];
  loading: boolean;
  error: string | null;
}

// Cache keyed by manifestId (content-addressed — sha256 of the manifest
// body, so immutable forever). A given manifest never changes, so cache
// entries are safe to reuse across the whole app session.
const cache = new Map<string, readonly ManifestFile[]>();
const inflight = new Map<string, Promise<readonly ManifestFile[]>>();

async function fetchManifestFiles(
  siteId: string,
  roostId: string,
  manifestId: string,
): Promise<readonly ManifestFile[]> {
  const cached = cache.get(manifestId);
  if (cached) return cached;
  const existing = inflight.get(manifestId);
  if (existing) return existing;

  const p = (async () => {
    // Server-side proxy — avoids R2's missing CORS headers on signed URLs.
    // The endpoint supports pagination via limit + cursor; we page through
    // until nextPageToken is empty so the caller gets the full list.
    // max limit is 500 per request.
    const collected: ManifestFile[] = [];
    let cursor = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const qs = new URLSearchParams({
        siteId,
        limit: '500',
      });
      if (cursor) qs.set('cursor', cursor);
      const res = await fetch(
        `/api/roosts/${encodeURIComponent(roostId)}/manifests/${encodeURIComponent(manifestId)}/files?${qs}`,
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
    cache.set(manifestId, collected);
    return collected as readonly ManifestFile[];
  })();
  inflight.set(manifestId, p);
  try {
    return await p;
  } finally {
    inflight.delete(manifestId);
  }
}

export function useRoostManifestFiles(
  siteId: string,
  roostId: string,
  manifestId: string | null,
  enabled: boolean,
): ManifestFilesResult {
  const [result, setResult] = useState<ManifestFilesResult>(() => {
    // Sync-seed from cache on mount if the manifest was already fetched
    // in a prior expand — avoids a loading flicker on re-expand.
    const seeded = manifestId ? cache.get(manifestId) : null;
    return {
      files: seeded ?? [],
      loading: enabled && !seeded && !!manifestId,
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
    if (!enabled || !manifestId || !siteId || !roostId) return;
    const cached = cache.get(manifestId);
    if (cached) {
      setResult({ files: cached, loading: false, error: null });
      return;
    }
    setResult((prev) => ({ ...prev, loading: true, error: null }));
    fetchManifestFiles(siteId, roostId, manifestId)
      .then((files) => {
        if (!aliveRef.current) return;
        setResult({ files, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (!aliveRef.current) return;
        setResult({ files: [], loading: false, error: err.message });
      });
  }, [enabled, siteId, roostId, manifestId]);

  return result;
}
