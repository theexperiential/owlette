'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ApiKeyListItem, ApiKeyScope } from '@/lib/apiKeyTypes';

/**
 * The single owner of every `/api/keys` request.
 *
 * Before this, six inline fetch sites across four files talked to the same
 * routes with quietly different behaviour: revoke filtered the row out locally
 * in one place and refetched in another, one surface sorted expired keys last
 * and the other did not, and only one validated the name before POSTing. The
 * two create paths had drifted far enough that one could not express what the
 * other could. Consolidating the transport is what makes one panel possible.
 *
 * Modelled on {@link usePasskeys} — fetch-based, never a direct Firestore read.
 * `users/{uid}/api_keys` and `api_keys/{keyHash}` are Admin-SDK-only; the
 * client has no read access to either and must not be given any.
 */

export interface CreateKeyInput {
  name: string;
  scopes: ApiKeyScope[];
  ttlDays?: number;
}

/**
 * `scopes` is a full replacement, not a merge — the route treats it that way,
 * and a partial merge on the client would disagree with the server about what
 * the key ends up holding.
 */
export interface UpdateKeyInput {
  name?: string;
  scopes?: ApiKeyScope[];
}

export interface CreatedKey {
  key: string;
  keyId: string;
  name: string;
  keyPrefix: string;
}

interface ApiProblem {
  detail?: string;
  error?: string;
  message?: string;
}

/** Pull the most useful message out of a problem+json body. */
async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as ApiProblem;
  return body.detail || body.error || body.message || fallback;
}

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKeyListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/keys');
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to load keys'));
      const data = (await res.json()) as { keys?: ApiKeyListItem[] };
      // Usable keys first. The route already orders by createdAt desc and
      // Array.prototype.sort is stable, so that ordering survives within each
      // group.
      const rows = data.keys ?? [];
      setKeys(
        [...rows].sort(
          (a, b) => Number(a.expired || a.retired) - Number(b.expired || b.retired),
        ),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  /** Returns the raw key — shown once, never retrievable again. */
  const createKey = useCallback(
    async (input: CreateKeyInput): Promise<CreatedKey> => {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to create key'));
      const created = (await res.json()) as CreatedKey;
      await refresh();
      return created;
    },
    [refresh],
  );

  /** Returns the new raw key. The predecessor keeps working until its grace window closes. */
  const rotateKey = useCallback(
    async (keyId: string, ttlDays?: number): Promise<CreatedKey> => {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttlDays === undefined ? {} : { ttlDays }),
      });
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to rotate key'));
      const rotated = (await res.json()) as CreatedKey;
      await refresh();
      return rotated;
    },
    [refresh],
  );

  /** Edits an existing key in place. The secret is unchanged, so nothing is returned to reveal. */
  const updateKey = useCallback(
    async (keyId: string, input: UpdateKeyInput): Promise<void> => {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to update key'));
      await refresh();
    },
    [refresh],
  );

  const revokeKey = useCallback(
    async (keyId: string): Promise<void> => {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to revoke key'));
      // Refetch rather than filtering locally: rotation can leave a
      // predecessor row whose state the server owns, and a local splice would
      // disagree with it.
      await refresh();
    },
    [refresh],
  );

  return { keys, loading, refresh, createKey, rotateKey, updateKey, revokeKey };
}
