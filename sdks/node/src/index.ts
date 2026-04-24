/**
 * `@owlette/roost` — node sdk entry point.
 *
 *   import { Roost } from '@owlette/roost';
 *   const roost = new Roost({ token: process.env.ROOST_TOKEN! });
 *   await roost.roosts.push('./dist', 'rst_abc', { siteId: 'site-1' });
 *
 * Every resource is lazily constructed on first access to keep the
 * constructor cheap — you can `new Roost()` inside a request handler
 * without measurable overhead.
 */

import { RoostClient, type RoostClientOpts, RoostApiError, DEFAULT_API_URL, DEFAULT_ROOST_VERSION } from './lib/client';
import { Roosts } from './resources/roosts';
import { Chunks } from './resources/chunks';
import { Manifests } from './resources/manifests';
import { Deployments } from './resources/deployments';
import { Webhooks } from './resources/webhooks';
import { Keys } from './resources/keys';
import { Sites } from './resources/sites';
import { Machines } from './resources/machines';
import { Quotas } from './resources/quotas';
import {
  verifySignature,
  isSignatureValid,
  signBody,
  type VerifySignatureOptions,
  type VerifySignatureResult,
} from './lib/signature';

const SDK_VERSION = '0.1.0';

export class Roost {
  readonly client: RoostClient;

  #roosts?: Roosts;
  #chunks?: Chunks;
  #manifests?: Manifests;
  #deployments?: Deployments;
  #webhooks?: Webhooks;
  #keys?: Keys;
  #sites?: Sites;
  #machines?: Machines;
  #quotas?: Quotas;

  constructor(opts: RoostClientOpts) {
    this.client = new RoostClient(opts);
  }

  get roosts(): Roosts {
    return (this.#roosts ??= new Roosts(this.client, SDK_VERSION));
  }

  get chunks(): Chunks {
    return (this.#chunks ??= new Chunks(this.client));
  }

  get manifests(): Manifests {
    return (this.#manifests ??= new Manifests(this.client));
  }

  get deployments(): Deployments {
    return (this.#deployments ??= new Deployments(this.client));
  }

  get webhooks(): Webhooks {
    return (this.#webhooks ??= new Webhooks(this.client));
  }

  get keys(): Keys {
    return (this.#keys ??= new Keys(this.client));
  }

  get sites(): Sites {
    return (this.#sites ??= new Sites(this.client));
  }

  get machines(): Machines {
    return (this.#machines ??= new Machines(this.client));
  }

  get quotas(): Quotas {
    return (this.#quotas ??= new Quotas(this.client));
  }

  /**
   * Webhook signature verification — static helpers grouped under
   * `roost.events` so calling sites read naturally:
   *
   *   if (!roost.events.verifySignature(header, body, secret)) {
   *     return res.status(401).send();
   *   }
   */
  readonly events = {
    verifySignature: (
      header: string | null | undefined,
      body: string | Buffer,
      secret: string,
      opts?: VerifySignatureOptions,
    ): VerifySignatureResult => verifySignature(header, body, secret, opts),
    isSignatureValid: (
      header: string | null | undefined,
      body: string | Buffer,
      secret: string,
      opts?: VerifySignatureOptions,
    ): boolean => isSignatureValid(header, body, secret, opts),
    signBody,
  };

  /** Get the raw low-level http client for escape-hatch calls. */
  get http(): RoostClient {
    return this.client;
  }
}

export { RoostClient, RoostApiError, DEFAULT_API_URL, DEFAULT_ROOST_VERSION };
export type {
  RoostClientOpts,
  Environment,
  ApiResponse,
  RequestOptions,
} from './lib/client';
export { verifySignature, isSignatureValid, signBody };
export type { VerifySignatureOptions, VerifySignatureResult } from './lib/signature';
export type {
  RoostSummary,
  RoostDetail,
  ManifestSummary,
  ListRoostsOptions,
  ListRoostsResult,
  CreateRoostOptions,
  PatchRoostOptions,
  RollbackOptions,
  RollbackResult,
  DeployOptions,
  DeployResult,
  PushOptions,
  PushProgressEvent,
  PushResult,
} from './resources/roosts';
export type { ApiKeyPermission, ApiKeyResource, ApiKeyScope, ApiKeyRecord } from './resources/keys';
export type { Site } from './resources/sites';
export type { MachineSummary, MachineDetail, MachineDeployment } from './resources/machines';
export type { QuotaSnapshot, QuotaHistoryDay } from './resources/quotas';
export type { WebhookSubscription } from './resources/webhooks';
export type { ManifestDetail, ManifestFilesPage, ManifestDiff } from './resources/manifests';
export type { ChunkedFileEntry, ChunkProgressEvent } from './lib/chunker';

export const VERSION = SDK_VERSION;
