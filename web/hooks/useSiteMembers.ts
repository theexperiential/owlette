'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The single owner of every `/api/sites/{siteId}/members` request.
 *
 * Fetch-based, never a Firestore listener: membership lives on `users/{uid}`,
 * and the rules deny cross-user reads — a client listener over the membership
 * query is impossible by design, so the server route is the only read path.
 */

/** Per-site role the route derives from global role + site ownership. */
export type SiteMemberRole = 'owner' | 'superadmin' | 'admin' | 'member';

/** The two roles the add endpoint accepts. */
export type AddableSiteMemberRole = 'admin' | 'member';

export interface SiteMember {
  uid: string;
  email: string | null;
  role: SiteMemberRole;
  /** Global (fleet-wide) role, e.g. 'member' — drives whether `role` was honored. */
  globalRole: string;
  displayName: string | null;
}

/** Email is the dashboard's affordance; the uid variant is server-side only. */
export interface AddSiteMemberInput {
  email: string;
  role: AddableSiteMemberRole;
}

export interface AddSiteMemberResult {
  uid: string;
  siteId: string;
  requestedRole: AddableSiteMemberRole;
  /**
   * `false` means the user was added to the site but keeps their global member
   * role — admin rights need a separate global role change. Callers should say so.
   */
  roleHonored: boolean;
  globalRole: string;
}

export interface RemoveSiteMemberResult {
  siteId: string;
  uid: string;
  wasMember: boolean;
  /** Talons this user authored on the site, counted before the removal. */
  talonCount: number;
  reassignedTalonIds: string[];
}

interface ApiProblem {
  detail?: string;
  title?: string;
  error?: string;
  message?: string;
}

/**
 * A non-2xx from one of the members endpoints, carrying the HTTP status.
 *
 * Without the status a caller can only sniff the prose (`/not found/i`), which
 * breaks the moment the route rewords its 404 — and misfires on any other
 * message that happens to contain those words. Mirrors `ApiRequestError` in
 * `useFirestore`; defined here rather than imported so this hook keeps its
 * fetch-only dependency graph.
 */
export class SiteMemberApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SiteMemberApiError';
    this.status = status;
  }
}

/** Non-2xx response -> an error carrying its status and best available message. */
async function problemError(
  res: Response,
  fallback: string,
): Promise<SiteMemberApiError> {
  const body = (await res.json().catch(() => ({}))) as ApiProblem;
  const message =
    body.detail || body.title || body.error || body.message || fallback;
  return new SiteMemberApiError(res.status, message);
}

// Duplicated per-hook rather than shared, matching the other mutation hooks.
function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const EMPTY_MEMBERS: SiteMember[] = [];

interface MembersState {
  members: SiteMember[];
  /** Which site `members`/`error` describe; null before the first settle. */
  loadedSiteId: string | null;
  error: string | null;
}

export interface UseSiteMembersResult {
  members: SiteMember[];
  loading: boolean;
  error: string | null;
  /** Never rejects — a failed refetch lands in `error`. */
  refresh: () => Promise<void>;
  addMember: (input: AddSiteMemberInput) => Promise<AddSiteMemberResult>;
  removeMember: (
    uid: string,
    talonSuccessorUid?: string,
  ) => Promise<RemoveSiteMemberResult>;
}

export function useSiteMembers(
  siteId: string | null | undefined,
): UseSiteMembersResult {
  const [state, setState] = useState<MembersState>({
    members: EMPTY_MEMBERS,
    loadedSiteId: null,
    error: null,
  });

  // Monotonic request token. Switching sites (or a manual refresh overlapping an
  // in-flight one) bumps it, so a late response for the previous site is dropped
  // instead of overwriting the newer list — the `loadedSiteId` guard alone would
  // still let the stale settle push the hook back into a loading state.
  const requestSeq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!siteId) return;
    const seq = ++requestSeq.current;
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/members`,
      );
      if (!res.ok) throw await problemError(res, 'failed to load members');
      const data = (await res.json()) as { members?: SiteMember[] };
      if (seq !== requestSeq.current) return;
      setState({
        members: data.members ?? EMPTY_MEMBERS,
        loadedSiteId: siteId,
        error: null,
      });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      // Pin loadedSiteId on the error path too, or `loading` stays true forever
      // and the page renders a permanent spinner instead of its error branch.
      setState({
        members: EMPTY_MEMBERS,
        loadedSiteId: siteId,
        error: err instanceof Error ? err.message : 'failed to load members',
      });
    }
  }, [siteId]);

  useEffect(() => {
    // `refresh` is inert without a siteId and never rejects.
    void refresh();
  }, [refresh]);

  const addMember = useCallback(
    async (input: AddSiteMemberInput): Promise<AddSiteMemberResult> => {
      if (!siteId) throw new Error('no site selected');
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/members`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': makeIdempotencyKey('site-member-add'),
          },
          body: JSON.stringify({ email: input.email, role: input.role }),
        },
      );
      if (!res.ok) throw await problemError(res, 'failed to add member');
      const added = (await res.json()) as AddSiteMemberResult;
      // Refetch rather than splice: the row's derived role and display name come
      // from the user doc, which this response doesn't carry.
      await refresh();
      return added;
    },
    [siteId, refresh],
  );

  const removeMember = useCallback(
    async (
      uid: string,
      talonSuccessorUid?: string,
    ): Promise<RemoveSiteMemberResult> => {
      if (!siteId) throw new Error('no site selected');
      const query = talonSuccessorUid
        ? `?talonSuccessorUid=${encodeURIComponent(talonSuccessorUid)}`
        : '';
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/members/${encodeURIComponent(uid)}${query}`,
        {
          method: 'DELETE',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': makeIdempotencyKey(`site-member-remove-${uid}`),
          },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) throw await problemError(res, 'failed to remove member');
      const removed = (await res.json()) as RemoveSiteMemberResult;
      await refresh();
      return removed;
    },
    [siteId, refresh],
  );

  const matches = !!siteId && state.loadedSiteId === siteId;

  return {
    members: matches ? state.members : EMPTY_MEMBERS,
    loading: !!siteId && !matches,
    error: matches ? state.error : null,
    refresh,
    addMember,
    removeMember,
  };
}
