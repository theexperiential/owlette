/**
 * `roost.members(siteId)` — site-scoped membership management (wave 3B).
 *
 *   GET    /api/sites/{siteId}/members
 *   POST   /api/sites/{siteId}/members           — body `{ uid, role }`
 *   DELETE /api/sites/{siteId}/members/{uid}
 *
 * The constructor binds to a `siteId`. Exposed as a factory on the root
 * `Roost` instance so callers do `roost.members(siteId).list()`.
 */
import { randomUUID } from 'crypto';
import type { RoostClient } from '../lib/client';

/* --------------------------------------------------------------------- */
/*  types                                                                */
/* --------------------------------------------------------------------- */

export type SiteMemberRole = 'owner' | 'superadmin' | 'admin' | 'member';

export interface SiteMember {
  uid: string;
  email: string | null;
  role: SiteMemberRole;
  globalRole: string;
  sites: string[];
  displayName: string | null;
}

export interface AddMemberOptions {
  uid: string;
  role: 'admin' | 'member';
  idempotencyKey?: string;
}

export interface AddMemberResult {
  uid: string;
  siteId: string;
  requestedRole: 'admin' | 'member';
  roleHonored: boolean;
  globalRole: string;
}

export interface RemoveMemberResult {
  siteId: string;
  uid: string;
  wasMember: boolean;
}

/* --------------------------------------------------------------------- */
/*  resource                                                             */
/* --------------------------------------------------------------------- */

export class Members {
  constructor(
    private readonly client: RoostClient,
    private readonly siteId: string,
  ) {}

  private get base(): string {
    return `/api/sites/${encodeURIComponent(this.siteId)}/members`;
  }

  async list(): Promise<SiteMember[]> {
    const res = await this.client.request<{ members: SiteMember[] }>(this.base);
    return res.data.members;
  }

  async add(opts: AddMemberOptions): Promise<AddMemberResult> {
    const res = await this.client.request<AddMemberResult>(this.base, {
      method: 'POST',
      body: { uid: opts.uid, role: opts.role },
      idempotencyKey: opts.idempotencyKey ?? `sdk-members-add-${randomUUID()}`,
    });
    return res.data;
  }

  async remove(uid: string): Promise<RemoveMemberResult> {
    const res = await this.client.request<RemoveMemberResult>(
      `${this.base}/${encodeURIComponent(uid)}`,
      { method: 'DELETE' },
    );
    return res.data;
  }
}
