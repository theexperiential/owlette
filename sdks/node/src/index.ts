/**
 * `@owlette/sdk` — node sdk entry point.
 *
 *   import { Roost } from '@owlette/sdk';
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
import { Versions } from './resources/versions';
import { Deployments } from './resources/deployments';
import { Webhooks } from './resources/webhooks';
import { Keys } from './resources/keys';
import { Account } from './resources/account';
import { Sites } from './resources/sites';
import { Machines } from './resources/machines';
import { Quotas } from './resources/quotas';
import { InstallerDeployments } from './resources/installerDeployments';
import { Installer } from './resources/installer';
import { Processes } from './resources/processes';
import { Chat } from './resources/chat';
import { Users } from './resources/users';
import { Members } from './resources/members';
import { SDK_VERSION } from './version';
import {
  verifySignature,
  isSignatureValid,
  signBody,
  type VerifySignatureOptions,
  type VerifySignatureResult,
} from './lib/signature';

export class Roost {
  readonly client: RoostClient;

  #roosts?: Roosts;
  #chunks?: Chunks;
  #versions?: Versions;
  #deployments?: Deployments;
  #webhooks?: Webhooks;
  #keys?: Keys;
  #account?: Account;
  #sites?: Sites;
  #machines?: Machines;
  #quotas?: Quotas;
  #installerDeployments?: InstallerDeployments;
  #installer?: Installer;
  #chat?: Chat;
  #users?: Users;

  constructor(opts: RoostClientOpts) {
    this.client = new RoostClient(opts);
  }

  get roosts(): Roosts {
    return (this.#roosts ??= new Roosts(this.client, SDK_VERSION));
  }

  get chunks(): Chunks {
    return (this.#chunks ??= new Chunks(this.client));
  }

  get versions(): Versions {
    return (this.#versions ??= new Versions(this.client));
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

  get account(): Account {
    return (this.#account ??= new Account(this.client));
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

  get installerDeployments(): InstallerDeployments {
    return (this.#installerDeployments ??= new InstallerDeployments(this.client));
  }

  get installer(): Installer {
    return (this.#installer ??= new Installer(this.client));
  }

  get chat(): Chat {
    return (this.#chat ??= new Chat(this.client));
  }

  get users(): Users {
    return (this.#users ??= new Users(this.client));
  }

  /**
   * Site-scoped process resource. Returns a fresh `Processes` instance bound
   * to the (siteId, machineId) tuple — not memoised because the tuple is
   * part of the constructor identity. Cheap to construct on each call.
   */
  processes(siteId: string, machineId: string): Processes {
    return new Processes(this.client, siteId, machineId);
  }

  /**
   * Site-scoped membership resource. Returns a fresh `Members` instance
   * bound to `siteId` — not memoised for the same reason as `processes()`.
   */
  members(siteId: string): Members {
    return new Members(this.client, siteId);
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
  VersionSummary,
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
export type {
  AccountApiKeyCreateOptions,
  AccountApiKeyCreateResult,
  AccountApiKeyRecord,
  AccountKeyContext,
  AccountQuotaSummary,
  AccountRateLimit,
  ApiVersionResponse,
  WhoamiResponse,
} from './resources/account';
export type {
  ApiKeyEnvironment,
  ApiKeyPermission,
  ApiKeyResource,
  ApiKeyScope,
  ApiKeyRecord,
} from './resources/keys';
export type { Site } from './resources/sites';
export type {
  MachineSummary,
  MachineDetail,
  MachineDeployment,
  MachineCommandType,
  MachineCommandStatus,
  DispatchCommandResult,
  CommandStatus,
  CaptureScreenshotOptions,
  CaptureScreenshotResult,
} from './resources/machines';
export type { QuotaSnapshot, QuotaHistoryDay } from './resources/quotas';
export type { ListDeploymentsOptions } from './resources/deployments';
export type {
  ListWebhookDeliveriesResult,
  ProbeWebhookOptions,
  WebhookDelivery,
  WebhookSubscription,
} from './resources/webhooks';
export type {
  ListVersionsResult,
  ListVersionsOptions,
  PatchVersionOptions,
  VersionDetail,
  VersionFilesPage,
  VersionDiff,
} from './resources/versions';
export type { ChunkedFileEntry, ChunkProgressEvent } from './lib/chunker';
export type {
  InstallerDeploymentTarget,
  InstallerDeploymentTargetStatus,
  InstallerDeploymentStatus,
  InstallerDeploymentSummary,
  InstallerDeploymentDetail,
  ListInstallerDeploymentsOptions,
  ListInstallerDeploymentsResult,
  CreateInstallerDeploymentOptions,
  CreateInstallerDeploymentResult,
  InstallerDeploymentMutationResult,
} from './resources/installerDeployments';
export type {
  InstallerVersion,
  ListInstallerOptions,
  ListInstallerResult,
  UploadRequestOptions,
  UploadResult,
} from './resources/installer';
export type {
  ProcessSummary,
  ProcessLaunchMode,
  ProcessScheduleBlock,
  ListProcessesResult,
  CreateProcessOptions,
  UpdateProcessOptions,
  ScheduleOptions,
} from './resources/processes';
export type {
  ChatRole,
  ConversationSummary,
  ListConversationsOptions,
  ListConversationsResult,
  CreateConversationOptions,
  CreateConversationResult,
  SendMessageOptions,
  SendMessageStream,
} from './resources/chat';
export type {
  UserRole,
  UserSummary,
  ListUsersOptions,
  ListUsersResult,
  RoleChangeResult,
  AssignSitesResult,
  RemoveSitesResult,
  DeleteUserResult,
} from './resources/users';
export type {
  SiteMemberRole,
  SiteMember,
  AddMemberOptions,
  AddMemberResult,
  RemoveMemberResult,
} from './resources/members';

export const VERSION = SDK_VERSION;
