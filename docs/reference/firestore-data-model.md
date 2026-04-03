# firestore data model

Complete schema for all Firestore collections and documents.

---

## collection hierarchy

```
firestore/
├── sites/{siteId}/
│   ├── machines/{machineId}/
│   │   ├── presence              (single document)
│   │   ├── status                (single document)
│   │   ├── commands/
│   │   │   ├── pending/{cmdId}
│   │   │   └── completed/{cmdId}
│   │   ├── screenshots/{screenshotId}
│   │   ├── installed_software/{softwareId}
│   │   ├── metrics_history/{bucketId}   (YYYY-MM-DD daily buckets)
│   │   ├── logs/{logId}                 (machine-level application logs)
│   │   └── cortex/
│   │       └── active-chat              (single document, local Cortex streaming)
│   ├── deployments/{deployId}
│   ├── project_distributions/{distId}
│   ├── installer_templates/{tplId}
│   ├── project_templates/{tplId}
│   ├── logs/{logId}
│   ├── webhooks/{webhookId}       (webhook notification configs)
│   ├── settings/
│   │   ├── llm                   (single document)
│   │   └── cortex                (single document, autonomous config)
│   ├── cortex-events/{eventId}   (autonomous investigation records)
│   └── cortex-state/
│       └── lock                  (single document, concurrency control)
│
├── config/{siteId}/
│   ├── machines/{machineId}      (single document)
│   └── schedule_presets/{presetId}
│
├── users/{userId}
│   ├── passkeys/{credentialId}   (WebAuthn credentials)
│   ├── api_keys/{keyId}
│   └── settings/
│       ├── llm
│       └── preferences
│
├── chats/{chatId}                (Cortex conversations)
│   └── messages/{messageId}
├── system_presets/{presetId}     (global deployment presets)
├── api_keys/{keyHash}             (fast-lookup index for user API keys)
├── agent_tokens/{registrationCode}
├── agent_refresh_tokens/{tokenHash}
├── device_codes/{phrase}         (device-code pairing)
├── mfa_pending/{userId}
├── webauthn_challenges/{challengeId}
├── installer_uploads/{uploadId}  (temporary, during installer upload)
├── bug_reports/{reportId}
└── installer_metadata/
    ├── latest                    (single document)
    └── data/versions/{version}
```

---

## sites/{siteId}

Top-level site document.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (e.g., "NYC Office") |
| `owner` | string | UID of the user who created the site |
| `createdAt` | timestamp | When the site was created |

---

## sites/{siteId}/machines/{machineId}/presence

Agent heartbeat — updated every 30 seconds.

| Field | Type | Description |
|-------|------|-------------|
| `online` | boolean | Whether the machine is connected |
| `lastHeartbeat` | timestamp | Last heartbeat time (server timestamp) |
| `agent_version` | string | Agent version (e.g., "2.1.8") |
| `os` | string | OS description (e.g., "Windows 11 Pro 10.0.22631") |

---

## sites/{siteId}/machines/{machineId}/status

System metrics — updated every 60 seconds.

| Field | Type | Description |
|-------|------|-------------|
| `cpu` | number | CPU usage percentage (0-100) |
| `memory` | number | RAM usage percentage (0-100) |
| `disk` | number | Primary disk usage percentage (0-100) |
| `gpu` | number | GPU usage percentage (0-100) |
| `cpu_model` | string | CPU model name |
| `processes` | map | Per-process status map (see below) |

### processes map

```json
{
  "TouchDesigner": {
    "status": "RUNNING",
    "pid": 12345,
    "uptime": 3600
  }
}
```

---

## sites/{siteId}/machines/{machineId}/commands/pending/{commandId}

Pending command from dashboard.

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Command type (see [Agent Commands](agent-commands.md)) |
| `timestamp` | number | Unix timestamp (milliseconds) |
| `status` | string | Always `"pending"` |
| _...additional fields_ | varies | Command-specific data (e.g., `process_name`, `installer_url`) |

---

## sites/{siteId}/machines/{machineId}/commands/completed/{commandId}

Completed command result.

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Original command type |
| `result` | string | Result message or error |
| `status` | string | `"completed"` or `"failed"` |
| `completedAt` | timestamp | When the command finished |

---

## sites/{siteId}/machines/{machineId}/screenshots/{screenshotId}

Screenshot captures from remote machines.

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Public Firebase Storage URL to the screenshot image |
| `timestamp` | number | Capture time (Unix milliseconds) |
| `sizeKB` | number | File size in kilobytes |

---

## sites/{siteId}/machines/{machineId}/installed_software/{softwareId}

Windows software inventory synced from the agent via registry scan.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name from Windows registry |
| `version` | string | Version string (may be empty) |
| `publisher` | string | Publisher/manufacturer name |
| `install_location` | string | Installation directory path |
| `uninstall_command` | string | Uninstall command from registry |
| `installer_type` | string | Detected type: `inno`, `nsis`, `msi`, `custom` |
| `registry_key` | string | Registry subkey name for reference |
| `detected_at` | timestamp | Server timestamp of detection |

---

## sites/{siteId}/machines/{machineId}/metrics_history/{bucketId}

Time-series metrics for sparkline charts. One document per day, keyed by `YYYY-MM-DD`.

| Field | Type | Description |
|-------|------|-------------|
| `samples` | array | Time-series metric samples (see below) |
| `meta.lastSample` | timestamp | Last sample timestamp |
| `meta.sampleCount` | number | Total samples in bucket |
| `meta.resolution` | string | Aggregation resolution |

### sample object

```json
{
  "t": 1712000000000,
  "c": 42.1,
  "m": 61.3,
  "d": 55.0,
  "g": 12.4,
  "ct": 68.0,
  "gt": 54.0
}
```

| Key | Description |
|-----|-------------|
| `t` | Timestamp (Unix ms) |
| `c` | CPU usage (%) |
| `m` | Memory usage (%) |
| `d` | Disk usage (%) |
| `g` | GPU usage (%) |
| `ct` | CPU temperature (°C) |
| `gt` | GPU temperature (°C) |

---

## config/{siteId}/machines/{machineId}

Process configuration synced between agent and dashboard.

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Config schema version |
| `processes` | array | Array of process objects |

### process object

```json
{
  "name": "TouchDesigner",
  "exe_path": "C:\\Program Files\\...",
  "file_path": "",
  "command_line_args": "",
  "autolaunch": true,
  "priority": "Normal",
  "visibility": "Normal",
  "launch_delay": 0,
  "init_time": 10,
  "relaunch_attempts": 5
}
```

---

## config/{siteId}/schedule_presets/{presetId}

Reusable process schedule presets scoped to a site.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Preset display name |
| `schedule.days` | array[string] | Days of week: `["mon", "tue", ...]` |
| `schedule.time` | string | Time in `HH:MM` format |
| `enabled` | boolean | Whether the preset is active |
| `createdAt` | timestamp | Creation time |
| `updatedAt` | timestamp | Last update time |

---

## users/{userId}

User account document.

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | User's email address |
| `displayName` | string | Full name (optional) |
| `role` | string | `"user"` or `"admin"` |
| `sites` | array[string] | Assigned site IDs |
| `createdAt` | timestamp | Registration date |
| `mfaEnabled` | boolean | Whether 2FA is active |
| `mfaSecret` | string | Encrypted TOTP secret (if MFA enabled) |
| `mfaBackupCodes` | array[string] | Hashed backup codes |
| `passkeyEnrolled` | boolean | Whether user has registered passkeys |

### users/{userId}/passkeys/{credentialId}

WebAuthn credential for passkey authentication.

| Field | Type | Description |
|-------|------|-------------|
| `credentialPublicKey` | string | Base64URL-encoded public key |
| `counter` | number | Signature counter (for clone detection) |
| `transports` | array[string] | `["internal", "usb", "ble", "nfc"]` |
| `deviceType` | string | `"singleDevice"` or `"multiDevice"` |
| `backedUp` | boolean | Whether credential is synced (e.g., iCloud Keychain) |
| `friendlyName` | string | User-assigned label (e.g., "MacBook Pro") |
| `createdAt` | timestamp | Registration date |
| `lastUsedAt` | timestamp | Last authentication date |

### users/{userId}/api_keys/{keyId}

User-scoped API keys for external integrations.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable label |
| `keyHash` | string | SHA-256 hash of the actual key value |
| `keyPrefix` | string | First 11 chars of key for display (e.g., `owk_abc1234`) |
| `createdAt` | number | Creation timestamp (Unix ms) |
| `lastUsedAt` | number\|null | Last usage timestamp (null if never used) |

### users/{userId}/settings/preferences

| Field | Type | Description |
|-------|------|-------------|
| `temperatureUnit` | string | `"celsius"` or `"fahrenheit"` |
| `healthAlerts` | boolean | Receive machine offline emails |
| `processAlerts` | boolean | Receive process crash emails |

### users/{userId}/settings/llm

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | `"anthropic"` or `"openai"` |
| `encryptedApiKey` | string | AES-encrypted API key |
| `model` | string | Model ID (optional) |
| `updatedAt` | timestamp | Last update time |

---

## api_keys/{keyHash}

Fast-lookup index for API key authentication. Keyed by SHA-256 hash of the raw key.

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Owner's user ID |
| `keyId` | string | Reference to `users/{userId}/api_keys/{keyId}` |

!!! warning "Server-only"
    Not accessible from any client. Only the server API can read/write.

---

## agent_tokens/{registrationCode}

One-time registration code for agent OAuth.

| Field | Type | Description |
|-------|------|-------------|
| `siteId` | string | Target site |
| `createdBy` | string | UID of admin who created it |
| `createdAt` | timestamp | Creation time |
| `expiresAt` | timestamp | Expiry (24 hours after creation) |
| `used` | boolean | Whether the code has been exchanged |
| `status` | string | `"pending"` |

!!! warning "Server-only"
    This collection is not accessible from any client (web or agent). Only the Admin SDK can read/write.

---

## agent_refresh_tokens/{tokenHash}

Hashed refresh tokens for agent authentication.

| Field | Type | Description |
|-------|------|-------------|
| `siteId` | string | Agent's site |
| `machineId` | string | Agent's machine hostname |
| `agentUid` | string | Firebase UID assigned to agent |
| `version` | string | Agent version when token was created |
| `createdAt` | timestamp | Token creation time |
| `lastUsed` | timestamp | Last refresh time |

!!! warning "Server-only"
    This collection is not accessible from any client. Only the Admin SDK can read/write.

---

## device_codes/{phrase}

Device code pairing state for the 3-word phrase auth flow. Documents are **ephemeral** — they are created when the agent requests a pairing phrase and deleted atomically when the agent polls and consumes the tokens, or when the code expires.

| Field | Type | Description |
|-------|------|-------------|
| `deviceCodeHash` | string | SHA-256 hash of the opaque device code |
| `machineId` | string\|null | Machine hostname (null for pre-authorized codes) |
| `version` | string\|null | Agent version |
| `status` | string | `"pending"` or `"authorized"` (document deleted on consumption or expiry) |
| `createdAt` | timestamp | Creation time |
| `expiresAt` | timestamp | Expiry (10 minutes) |
| `siteId` | string\|null | Site ID (populated on authorization) |
| `authorizedBy` | string\|null | Admin UID who authorized |
| `authorizedAt` | timestamp\|null | Authorization timestamp |
| `accessToken` | string\|null | Firebase access token (populated on authorization, never persisted — document deleted on poll) |
| `refreshToken` | string\|null | Refresh token (populated on authorization, never persisted — document deleted on poll) |

!!! warning "Server-only"
    Not accessible from any client. Only the server API can read/write.

!!! info "Lifecycle"
    `pending` → `authorized` (tokens written) → **deleted** (agent polls and consumes tokens). Expired documents are also deleted on first access. No documents should persist in this collection long-term.

---

## mfa_pending/{userId}

Temporary MFA setup state.

| Field | Type | Description |
|-------|------|-------------|
| `secret` | string | TOTP secret (plaintext, temporary) |
| `email` | string | User's email |
| `createdAt` | timestamp | When setup was initiated |
| `expiresAt` | timestamp | Expiry (10 minutes) |

---

## webauthn_challenges/{challengeId}

Temporary WebAuthn challenge for passkey registration or authentication.

| Field | Type | Description |
|-------|------|-------------|
| `challenge` | string | Base64URL-encoded challenge |
| `userId` | string\|null | User ID (null for authentication, userId for registration) |
| `type` | string | `"registration"` or `"authentication"` |
| `createdAt` | timestamp | When challenge was generated |
| `expiresAt` | timestamp | Expiry (10 minutes) |

!!! warning "Single-use"
    Challenges are deleted immediately after verification. Expired challenges are also rejected.

---

## installer_uploads/{uploadId}

Temporary document tracking an in-progress installer upload. Cleaned up after finalization.

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Semver version string (e.g., `"2.5.5"`) |
| `fileName` | string | Installer filename (must end in `.exe`) |
| `storagePath` | string | Firebase Storage destination path |
| `userId` | string | Admin UID who initiated the upload |
| `releaseNotes` | string\|null | Optional release notes |
| `setAsLatest` | boolean | Whether to mark as latest on finalization |
| `status` | string | `"pending"`, `"completed"`, or `"expired"` |
| `createdAt` | number | Creation timestamp (Unix ms) |
| `expiresAt` | number | Signed URL expiry timestamp |
| `completedAt` | number | Finalization timestamp (added on completion) |
| `file_size` | number | File size in bytes (added on finalization) |

---

## installer_metadata/latest

Current latest installer version.

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Version number (e.g., "2.1.8") |
| `download_url` | string | Firebase Storage download URL |
| `file_size` | number | File size in bytes |
| `release_date` | timestamp | Upload date |
| `checksum_sha256` | string | SHA-256 hash of the installer |
| `release_notes` | string | Change description (optional) |
| `uploaded_by` | string | Admin UID |

---

## sites/{siteId}/deployments/{deploymentId}

Software deployment record.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Deployment name |
| `installer_name` | string | Filename |
| `installer_url` | string | Download URL |
| `silent_flags` | string | Installation flags |
| `verify_path` | string | Post-install verification path |
| `targets` | array | `[{machineId, status, progress}]` |
| `status` | string | `pending`, `in_progress`, `completed`, `failed` |
| `createdBy` | string | UID |
| `createdAt` | timestamp | Creation time |

---

## sites/{siteId}/project_distributions/{distributionId}

Project file distribution record.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Distribution name |
| `project_name` | string | ZIP filename (from URL) |
| `project_url` | string | Download URL |
| `extract_path` | string | Target extraction path |
| `verify_files` | array[string] | Files to verify after extraction |
| `targets` | array | `[{machineId, status, progress}]` |
| `status` | string | `pending`, `in_progress`, `completed`, `failed`, `partial` |
| `createdAt` | timestamp | Creation time |

---

## sites/{siteId}/logs/{logId}

Event log entries.

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | timestamp | Event time |
| `action` | string | Event type (e.g., `process_crashed`) |
| `level` | string | `info`, `warning`, `error` |
| `machineId` | string | Source machine (optional) |
| `processName` | string | Related process (optional) |
| `details` | map | Additional context |

---

## sites/{siteId}/webhooks/{webhookId}

Webhook notification configurations.

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Webhook delivery URL (must be HTTPS) |
| `name` | string | Display name |
| `events` | array[string] | Subscribed events: `process.crashed`, `machine.offline`, etc. |
| `enabled` | boolean | Whether the webhook is active |
| `secret` | string | HMAC-SHA256 signing secret (hex-encoded) |
| `createdAt` | timestamp | Creation time |
| `createdBy` | string | Admin UID who created it |
| `lastTriggered` | timestamp\|null | Last delivery attempt |
| `lastStatus` | number | Last HTTP response status (0 if never fired) |
| `failCount` | number | Consecutive delivery failures (auto-disables at 10) |

---

## sites/{siteId}/settings/cortex

Autonomous Cortex configuration. Created per-site, disabled by default.

| Field | Type | Description |
|-------|------|-------------|
| `autonomousEnabled` | boolean | Whether autonomous mode is active |
| `directive` | string | Custom directive text (empty = use default) |
| `maxTier` | number | Max tool tier (1=read-only, 2=+process mgmt, 3=+shell) |
| `autonomousModel` | string\|null | Override LLM model for autonomous mode |
| `maxEventsPerHour` | number | Incoming event throttle per site |
| `cooldownMinutes` | number | Per machine+process cooldown between investigations |
| `escalationEmail` | boolean | Email admins when Cortex escalates |
| `updatedAt` | timestamp | Last update |

---

## sites/{siteId}/cortex-events/{eventId}

Autonomous investigation records — one per triggered event.

| Field | Type | Description |
|-------|------|-------------|
| `machineId` | string | Machine that triggered the event |
| `machineName` | string | Machine display name |
| `processName` | string | Process involved |
| `eventType` | string | `process_crash` or `process_start_failed` |
| `errorMessage` | string | Error details from agent |
| `timestamp` | timestamp | When the event was received |
| `chatId` | string | Links to `chats/{chatId}` |
| `status` | string | `investigating`, `resolved`, `escalated`, `failed` |
| `summary` | string | One-line outcome summary |
| `actions` | array | Tool calls made: `[{tool, params, timestamp}]` |
| `resolvedAt` | timestamp | When investigation completed |
| `durationMs` | number | Total investigation time |

---

## sites/{siteId}/cortex-state/lock

Concurrency control for autonomous sessions.

| Field | Type | Description |
|-------|------|-------------|
| `activeSessions` | number | Currently running autonomous investigations |
| `lastUpdated` | timestamp | Last lock update |

---

## system_presets/{presetId}

Global software deployment presets (e.g., Owlette Agent self-update, TouchDesigner). Admin-managed, read-only to users.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable preset name |
| `software_name` | string | Name of the software being deployed |
| `category` | string | Software category |
| `description` | string | Description of what the preset installs |
| `installer_name` | string | Installer filename |
| `installer_url` | string | Download URL (must be HTTPS) |
| `silent_flags` | string | Silent installation flags |
| `verify_path` | string\|null | Path to verify installation success |
| `close_processes` | array[string] | Processes to close before installing |
| `timeout_seconds` | number\|null | Installation timeout override |
| `order` | number | Sort order in UI |
| `createdAt` | timestamp | Creation time |

---

## chats/{chatId}

Cortex conversation records (both user-initiated and autonomous).

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | User who created the chat (absent for autonomous) |
| `siteId` | string | Site context |
| `targetType` | string | `machine` or `site` |
| `targetMachineId` | string\|null | Target machine ID |
| `machineName` | string\|null | Machine display name |
| `title` | string | Conversation title (first message, truncated to 100 chars) |
| `source` | string | `user` or `autonomous` |
| `eventId` | string\|null | Links to `cortex-events/{eventId}` (autonomous only) |
| `autonomousSummary` | string\|null | Quick outcome summary (autonomous only) |
| `category` | string\|null | LLM-generated topic category |
| `createdAt` | timestamp | When the chat started |
| `updatedAt` | timestamp | Last activity |

### chats/{chatId}/messages/{messageId}

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | `"user"` or `"assistant"` |
| `content` | string | Message text content |
| `createdAt` | timestamp | Message creation time |

---

## bug_reports/{reportId}

Bug reports and feedback submissions from users and agents.

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | `"agent"` or `"web"` |
| `category` | string | `"bug"`, `"feature_request"`, `"other"`, `"compliment"`, `"rant"` |
| `title` | string | Report title (max 200 chars) |
| `description` | string | Full description (max 50,000 chars) |
| `status` | string | `"new"` |
| `createdAt` | timestamp | Submission time |
| `userId` | string | Reporting user ID |
| `userEmail` | string | User email (empty for agent reports) |
| `browserUA` | string | Browser user agent string |
| `pageUrl` | string | Page URL at time of report |
| `appVersion` | string | App version at time of report |
