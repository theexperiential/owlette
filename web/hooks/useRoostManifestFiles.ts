'use client';

/**
 * useRoostManifestFiles — lazy-fetch the file list for a roost's current
 * manifest. Only fires the network request when `enabled=true`, and
 * caches results in a module-level map keyed by manifestId so
 * collapse/expand cycles don't refetch.
 *
 * The manifest JSON lives in R2 (signed GET URL minted by
 * /api/roosts/{roostId}/manifest-url, which has a 15 min TTL). We only
 * pull out `path` + `size` per file — enough to render the expanded
 * list without pulling the chunk arrays, which can be huge on a 100 GB
 * roost but don't matter to the user at read time.
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
    const urlRes = await fetch(
      `/api/roosts/${encodeURIComponent(roostId)}/manifest-url`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, manifestId }),
      },
    );
    if (!urlRes.ok) {
      const body = await urlRes.json().catch(() => ({}));
      throw new Error(body.detail ?? body.title ?? `HTTP ${urlRes.status}`);
    }
    const { url } = (await urlRes.json()) as { url?: string };
    if (typeof url !== 'string' || !url) {
      throw new Error('manifest-url response missing `url`');
    }

    const manifestRes = await fetch(url);
    if (!manifestRes.ok) {
      throw new Error(`manifest fetch failed: HTTP ${manifestRes.status}`);
    }
    const manifest = (await manifestRes.json()) as {
      files?: Array<{ path?: unknown; size?: unknown }>;
    };
    const files: ManifestFile[] = [];
    for (const f of manifest.files ?? []) {
      if (typeof f.path === 'string' && typeof f.size === 'number') {
        files.push({ path: f.path, size: f.size });
      }
    }
    // sort: paths alphabetically so the list is deterministic regardless
    // of upload order. mirrors how file explorers default.
    files.sort((a, b) => a.path.localeCompare(b.path));
    Object.freeze(files);
    cache.set(manifestId, files);
    return files as readonly ManifestFile[];
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
