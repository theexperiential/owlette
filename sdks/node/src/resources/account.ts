import type { RoostClient } from '../lib/client';
import type {
  ApiKeyEnvironment,
  ApiKeyRecord,
  ApiKeyScope,
} from './keys';

export interface AccountKeyContext {
  keyId: string | null;
  name: string | null;
  keyPrefix: string | null;
  scopes: ApiKeyScope[] | null;
  environment: ApiKeyEnvironment | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  isLegacy: boolean;
}

export interface AccountRateLimit {
  tier?: string;
  limitPerMinute?: number;
  note?: string;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  [key: string]: unknown;
}

export interface AccountQuotaSummary {
  siteId?: string;
  tier?: string;
  usedBytes?: number;
  pendingBytes?: number;
  limitBytes?: number | null;
  [key: string]: unknown;
}

export interface WhoamiResponse {
  userId: string | null;
  email: string | null;
  role: string | null;
  key: AccountKeyContext | null;
  rateLimit: AccountRateLimit | null;
  quota: AccountQuotaSummary | null;
  primarySiteId: string | null;
}

export interface ApiVersionResponse {
  current: string;
  supported: string[];
  deprecated?: string[];
  retired?: string[];
}

export type AccountApiKeyRecord = ApiKeyRecord;

export interface AccountApiKeyCreateOptions {
  /**
   * Display name for the new key. The server inherits the caller's allowed
   * scopes for API-key callers, so this endpoint cannot widen privileges.
   */
  name?: string;
}

export interface AccountApiKeyCreateResult {
  success: true;
  key: string;
  keyId: string;
  name: string;
  environment: ApiKeyEnvironment;
  scopes: ApiKeyScope[];
  expiresAt: number;
  keyPrefix: string;
}

export class AccountApiKeys {
  constructor(private readonly client: RoostClient) {}

  async list(): Promise<AccountApiKeyRecord[]> {
    const res = await this.client.request<{
      success: true;
      keys: AccountApiKeyRecord[];
    }>('/api/account/api-keys');
    return res.data.keys;
  }

  async create(
    opts: AccountApiKeyCreateOptions = {},
  ): Promise<AccountApiKeyCreateResult> {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    const res = await this.client.request<AccountApiKeyCreateResult>(
      '/api/account/api-keys',
      {
        method: 'POST',
        body,
      },
    );
    return res.data;
  }

  async revoke(keyId: string): Promise<void> {
    await this.client.request<{ success: true }>(
      `/api/account/api-keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' },
    );
  }
}

export class Account {
  #apiKeys?: AccountApiKeys;

  constructor(private readonly client: RoostClient) {}

  get apiKeys(): AccountApiKeys {
    return (this.#apiKeys ??= new AccountApiKeys(this.client));
  }

  async whoami(): Promise<WhoamiResponse> {
    const res = await this.client.request<WhoamiResponse>('/api/whoami');
    return res.data;
  }

  async version(): Promise<ApiVersionResponse> {
    const res = await this.client.request<ApiVersionResponse>('/api/version');
    return res.data;
  }
}
