/**
 * `owlette.users` — superadmin-only platform user management (wave 3B).
 *
 *   GET    /api/users
 *   GET    /api/users/{uid}
 *   POST   /api/users/{uid}/promote
 *   POST   /api/users/{uid}/demote
 *   POST   /api/users/{uid}/assign-sites
 *   POST   /api/users/{uid}/remove-sites
 *   DELETE /api/users/{uid}
 *
 * Stable error codes surfaced by these endpoints (`last_superadmin`,
 * `orphan_sites`, `successor_invalid`, `unknown_site`) live on the thrown
 * `OwletteApiError.code` field — callers can `instanceof`-check the
 * error and switch on `.code` rather than parsing prose.
 */
import { randomUUID } from 'crypto';
import type { OwletteClient } from '../lib/client';

/* --------------------------------------------------------------------- */
/*  types                                                                */
/* --------------------------------------------------------------------- */

export type UserRole = 'member' | 'admin' | 'superadmin';

export interface UserSummary {
  uid: string;
  email: string | null;
  role: string;
  sites: string[];
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  createdAt: string | null;
  deletedAt: number | null;
}

export interface ListUsersOptions {
  pageSize?: number;
  pageToken?: string;
  role?: UserRole;
  site?: string;
  includeDeleted?: boolean;
}

export interface ListUsersResult {
  users: UserSummary[];
  nextPageToken: string;
}

export interface RoleChangeResult {
  uid: string;
  role: UserRole;
  previousRole: string;
  changed: boolean;
}

export interface AssignSitesResult {
  uid: string;
  assignedSiteIds: string[];
}

export interface RemoveSitesResult {
  uid: string;
  removedSiteIds: string[];
  cancelledCommandCount: number;
}

export interface DeleteUserResult {
  uid: string;
  alreadyDeleted: boolean;
  deletedAt: number;
  transferredSites?: string[];
  revokedKeyIds?: string[];
}

/* --------------------------------------------------------------------- */
/*  resource                                                             */
/* --------------------------------------------------------------------- */

export class Users {
  constructor(private readonly client: OwletteClient) {}

  async list(opts: ListUsersOptions = {}): Promise<ListUsersResult> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.pageSize !== undefined) query.page_size = opts.pageSize;
    if (opts.pageToken !== undefined) query.page_token = opts.pageToken;
    if (opts.role !== undefined) query.role = opts.role;
    if (opts.site !== undefined) query.site = opts.site;
    if (opts.includeDeleted) query.includeDeleted = 'true';

    const res = await this.client.request<ListUsersResult>('/api/users', { query });
    return res.data;
  }

  async get(uid: string): Promise<UserSummary> {
    const res = await this.client.request<UserSummary>(
      `/api/users/${encodeURIComponent(uid)}`,
    );
    return res.data;
  }

  async promote(
    uid: string,
    role: 'admin' | 'superadmin',
    opts: { idempotencyKey?: string } = {},
  ): Promise<RoleChangeResult> {
    const res = await this.client.request<RoleChangeResult>(
      `/api/users/${encodeURIComponent(uid)}/promote`,
      {
        method: 'POST',
        body: { role },
        idempotencyKey: opts.idempotencyKey ?? `sdk-users-promote-${randomUUID()}`,
      },
    );
    return res.data;
  }

  async demote(
    uid: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<RoleChangeResult> {
    const res = await this.client.request<RoleChangeResult>(
      `/api/users/${encodeURIComponent(uid)}/demote`,
      {
        method: 'POST',
        body: {},
        idempotencyKey: opts.idempotencyKey ?? `sdk-users-demote-${randomUUID()}`,
      },
    );
    return res.data;
  }

  async assignSites(
    uid: string,
    siteIds: readonly string[],
    opts: { idempotencyKey?: string } = {},
  ): Promise<AssignSitesResult> {
    const res = await this.client.request<AssignSitesResult>(
      `/api/users/${encodeURIComponent(uid)}/assign-sites`,
      {
        method: 'POST',
        body: { siteIds: [...siteIds] },
        idempotencyKey:
          opts.idempotencyKey ?? `sdk-users-assign-sites-${randomUUID()}`,
      },
    );
    return res.data;
  }

  async removeSites(
    uid: string,
    siteIds: readonly string[],
    opts: { idempotencyKey?: string } = {},
  ): Promise<RemoveSitesResult> {
    const res = await this.client.request<RemoveSitesResult>(
      `/api/users/${encodeURIComponent(uid)}/remove-sites`,
      {
        method: 'POST',
        body: { siteIds: [...siteIds] },
        idempotencyKey:
          opts.idempotencyKey ?? `sdk-users-remove-sites-${randomUUID()}`,
      },
    );
    return res.data;
  }

  async delete(
    uid: string,
    opts: { successorUid?: string } = {},
  ): Promise<DeleteUserResult> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.successorUid !== undefined) query.successorUid = opts.successorUid;
    const res = await this.client.request<DeleteUserResult>(
      `/api/users/${encodeURIComponent(uid)}`,
      {
        method: 'DELETE',
        query,
      },
    );
    return res.data;
  }
}
