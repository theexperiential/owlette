# rest api reference

> **Note:** This document has been superseded by the interactive API documentation at
> [`/docs/api`](https://owlette.app/docs/api) (or `localhost:3000/docs/api` in development).
> The interactive docs are powered by OpenAPI 3.1 and include a "Try It" panel for testing
> endpoints live. This file is retained as a reference but may become stale.

All HTTP endpoints exposed by the owlette web dashboard. 51 route files under `web/app/api/`, producing **~65 distinct method+path combinations**.

---

## table of contents

- [Authentication APIs](#authentication-apis) (3 endpoints)
- [MFA APIs](#mfa-apis) (3 endpoints)
- [Passkey APIs](#passkey-apis) (7 endpoints)
- [Agent Authentication APIs](#agent-authentication-apis) (3 endpoints)
- [Agent Alert API](#agent-alert-api) (1 endpoint)
- [Agent Screenshot API](#agent-screenshot-api) (1 endpoint)
- [Admin Machine APIs](#admin-machine-apis) (3 endpoints)
- [Admin Command APIs](#admin-command-apis) (2 endpoints)
- [Admin Software Inventory API](#admin-software-inventory-api) (1 endpoint)
- [Admin Process APIs](#admin-process-apis) (5 endpoints)
- [Admin Deployment APIs](#admin-deployment-apis) (5 endpoints)
- [Admin Installer APIs](#admin-installer-apis) (4 endpoints)
- [Admin Site APIs](#admin-site-apis) (1 endpoint)
- [Admin Token APIs](#admin-token-apis) (2 endpoints)
- [Admin Log API](#admin-log-api) (1 endpoint)
- [Admin Event API](#admin-event-api) (1 endpoint)
- [Admin Webhook APIs](#admin-webhook-apis) (4 endpoints)
- [Admin API Key APIs](#admin-api-key-apis) (3 endpoints)
- [Setup API](#setup-api) (1 endpoint)
- [Cortex APIs](#cortex-apis) (4 endpoints)
- [LLM Settings APIs](#llm-settings-apis) (6 endpoints)
- [Utility APIs](#utility-apis) (4 endpoints)

---

## authentication apis

### create session

Creates a server-side session after Firebase authentication.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/auth/session` |
| **Auth** | Firebase ID Token (in body) |
| **Rate Limit** | 10 requests/min per IP |

**Request Body:**

```json
{
  "idToken": "eyJhbGciOi..."
}
```

**Response (200):**

```json
{
  "success": true
}
```

Sets an HTTPOnly `session` cookie (iron-session, encrypted).

---

### destroy session

Signs the user out by clearing the session cookie.

| | |
|---|---|
| **Method** | `DELETE` |
| **URL** | `/api/auth/session` |
| **Auth** | Session cookie |

**Response (200):**

```json
{
  "success": true
}
```

---

### get session status

Returns current session information (for debugging).

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/auth/session` |
| **Auth** | Session cookie |

**Response (200):**

```json
{
  "authenticated": true,
  "uid": "abc123",
  "email": "user@example.com"
}
```

---

## mfa apis

### setup mfa

Generates TOTP secret and QR code for 2FA setup.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/mfa/setup` |
| **Auth** | Session cookie |
| **Rate Limit** | Auth strategy |

**Response (200):**

```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "qrCodeUrl": "otpauth://totp/owlette:user@example.com?secret=..."
}
```

Stores pending setup in Firestore `mfa_pending/{userId}` with 10-minute expiry.

---

### verify mfa setup

Confirms TOTP code during initial 2FA setup.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/mfa/verify-setup` |
| **Auth** | Session cookie |

**Request Body:**

```json
{
  "code": "123456"
}
```

**Response (200):**

```json
{
  "success": true,
  "backupCodes": ["abc123", "def456", "..."]
}
```

Encrypts secret and stores in user document. Hashes backup codes.

---

### verify mfa login

Verifies TOTP or backup code during login.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/mfa/verify-login` |
| **Auth** | Session cookie |

**Request Body:**

```json
{
  "code": "123456"
}
```

**Response (200):**

```json
{
  "success": true
}
```

---

## passkey apis

### register passkey options

Generates WebAuthn credential creation options for registering a new passkey.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/passkeys/register/options` |
| **Auth** | Session cookie |

**Request Body:**

```json
{
  "userId": "uid123"
}
```

**Response (200):**

Returns `PublicKeyCredentialCreationOptions` object. Challenge stored in Firestore with 10-minute expiry.

---

### register passkey verify

Verifies and stores the newly created passkey credential.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/passkeys/register/verify` |
| **Auth** | Session cookie |

**Request Body:**

```json
{
  "userId": "uid123",
  "credential": { "...WebAuthn attestation response..." },
  "friendlyName": "My YubiKey"
}
```

**Response (200):**

```json
{
  "success": true,
  "credentialId": "cred_abc123"
}
```

---

### authenticate passkey options

Generates WebAuthn authentication options for login. Called before the user is authenticated.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/passkeys/authenticate/options` |
| **Auth** | None (pre-login) |

**Response (200):**

```json
{
  "options": { "...PublicKeyCredentialRequestOptions..." },
  "challengeId": "ch_abc123"
}
```

---

### authenticate passkey verify

Verifies a passkey assertion and creates a session. Bypasses MFA.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/passkeys/authenticate/verify` |
| **Auth** | None (pre-login) |

**Request Body:**

```json
{
  "credential": { "...WebAuthn assertion response..." },
  "challengeId": "ch_abc123"
}
```

**Response (200):**

```json
{
  "success": true,
  "customToken": "eyJhbG...",
  "userId": "uid123"
}
```

Creates a session cookie. Passkey login bypasses MFA entirely.

---

### list passkeys

Returns all registered passkeys for a user.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/passkeys/list?userId=xxx` |
| **Auth** | Session cookie |

**Response (200):**

```json
{
  "passkeys": [
    {
      "credentialId": "cred_abc123",
      "friendlyName": "My YubiKey",
      "createdAt": "2026-03-20T10:00:00Z",
      "lastUsedAt": "2026-03-21T14:30:00Z"
    }
  ]
}
```

---

### rename passkey

Updates the friendly name of a registered passkey.

| | |
|---|---|
| **Method** | `PATCH` |
| **URL** | `/api/passkeys/{credentialId}` |
| **Auth** | Session cookie |

**Request Body:**

```json
{
  "userId": "uid123",
  "friendlyName": "Office YubiKey"
}
```

**Response (200):**

```json
{
  "success": true
}
```

---

### delete passkey

Removes a registered passkey.

| | |
|---|---|
| **Method** | `DELETE` |
| **URL** | `/api/passkeys/{credentialId}?userId=xxx` |
| **Auth** | Session cookie |

**Response (200):**

```json
{
  "success": true
}
```

---

## agent authentication apis

### exchange registration code

Exchanges a one-time registration code for OAuth tokens.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/agent/auth/exchange` |
| **Auth** | Registration code (in body) |
| **Rate Limit** | 20 attempts/hour per IP |

**Request Body:**

```json
{
  "registrationCode": "abc123def456",
  "machineId": "DESKTOP-ABC123"
}
```

**Response (200):**

```json
{
  "customToken": "eyJhbG...",
  "idToken": "eyJhbG...",
  "refreshToken": "rt_abc123...",
  "siteId": "nyc-office",
  "expiresIn": 3600
}
```

Marks the registration code as used. Creates agent UID in Firebase Auth.

---

### refresh access token

Refreshes an expired access token using the long-lived refresh token.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/agent/auth/refresh` |
| **Auth** | Refresh token (in body) |
| **Rate Limit** | 20 requests/hour per IP |

**Request Body:**

```json
{
  "refreshToken": "rt_abc123...",
  "machineId": "DESKTOP-ABC123"
}
```

**Response (200):**

```json
{
  "customToken": "eyJhbG...",
  "idToken": "eyJhbG...",
  "expiresIn": 3600
}
```

Validates machine ID matches the token's original machine.

---

### generate installer

Generates a registration code for agent installation.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/agent/generate-installer` |
| **Auth** | Session cookie |

**Request Body:**

```json
{
  "siteId": "nyc-office"
}
```

**Response (200):**

```json
{
  "registrationCode": "abc123def456",
  "expiresAt": "2026-03-22T12:00:00Z",
  "siteId": "nyc-office"
}
```

Code expires in 24 hours.

---

## agent alert api

### send alert

Agent-authenticated endpoint for sending alert notifications.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/agent/alert` |
| **Auth** | Bearer token (agent ID token) |
| **Rate Limit** | 5/hr per IP (connection failures), 3/hr per process per machine (process alerts) |

**Request Body:**

```json
{
  "type": "process_crash",
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "machineName": "Gallery PC 1",
  "data": {
    "processName": "TouchDesigner",
    "errorMessage": "Process exited with code -1073741819"
  }
}
```

**Alert Types:** `connection_failure`, `process_crash`, `process_start_failed`

**Response (200):**

```json
{
  "success": true,
  "emailSent": true
}
```

---

## agent screenshot api

### upload screenshot

Agent uploads a screenshot (base64 JPEG) for a machine. Stores the latest screenshot plus a history of up to 20 entries in Firebase Storage.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/agent/screenshot` |
| **Auth** | Bearer token (agent ID token) |
| **Max Body** | 10 MB |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "screenshot": "/9j/4AAQSkZJRg..."
}
```

The `screenshot` field is a base64-encoded JPEG image.

**Response (200):**

```json
{
  "success": true,
  "sizeKB": 245,
  "url": "https://storage.googleapis.com/..."
}
```

---

## admin machine apis

### list machines

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/machines?siteId=xxx` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "machines": [
    {
      "id": "DESKTOP-ABC123",
      "name": "DESKTOP-ABC123",
      "online": true,
      "lastHeartbeat": "2026-03-21T10:30:00Z",
      "agentVersion": "2.1.8",
      "os": "Windows 11 Pro"
    }
  ]
}
```

---

### get machine status

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/machines/status?siteId=xxx&machineId=xxx` |
| **Auth** | Session cookie (admin) |

Returns detailed machine info including metrics, processes, health, and agent version.

---

### trigger agent self-update

Sends an `update_owlette` command to a machine to trigger a self-update.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/machines/update` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "version": "2.3.1",
  "installer_url": "https://firebasestorage.googleapis.com/.../Owlette-Installer-v2.3.1.exe"
}
```

---

## admin command apis

### send command

Send a command to a machine via Firestore.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/commands/send` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "command": "restart_process",
  "data": { "process_name": "TouchDesigner" },
  "wait": true,
  "timeout": 30
}
```

When `wait: true`, polls for completion and returns the result. Timeout: 30-120 seconds.

---

### clear commands

Clears pending commands for a machine.

| | |
|---|---|
| **Method** | `DELETE` |
| **URL** | `/api/admin/commands/clear?siteId=xxx&machineId=xxx` |
| **Auth** | Session cookie (admin) |

---

## admin software inventory api

### get software inventory

Returns the installed software list for a machine.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/software-inventory?siteId=xxx&machineId=xxx` |
| **Auth** | Session cookie (admin) |

---

## admin process apis

### list processes

Returns all configured processes for a machine.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/processes?siteId=xxx&machineId=yyy` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "processes": [
    {
      "id": "proc_abc123",
      "name": "TouchDesigner",
      "exe_path": "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe",
      "launch_mode": "always",
      "status": "running"
    }
  ]
}
```

---

### add process

Adds a new monitored process configuration for a machine.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/processes` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "name": "TouchDesigner",
  "exe_path": "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe"
}
```

**Response (200):**

```json
{
  "processId": "proc_abc123"
}
```

---

### update process

Updates fields on an existing process configuration.

| | |
|---|---|
| **Method** | `PATCH` |
| **URL** | `/api/admin/processes/{processId}` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "name": "TouchDesigner Updated",
  "exe_path": "C:\\Program Files\\Derivative\\TouchDesigner099\\bin\\TouchDesigner099.exe"
}
```

**Response (200):**

```json
{
  "success": true
}
```

---

### delete process

Removes a process configuration from a machine.

| | |
|---|---|
| **Method** | `DELETE` |
| **URL** | `/api/admin/processes/{processId}?siteId=xxx&machineId=yyy` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "success": true
}
```

---

### update process launch mode

Sets the launch mode and optional schedule for a process.

| | |
|---|---|
| **Method** | `PATCH` |
| **URL** | `/api/admin/processes/{processId}/launch-mode` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "mode": "scheduled",
  "schedules": [
    {
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "startTime": "08:00",
      "endTime": "18:00"
    }
  ]
}
```

**Launch Modes:** `off`, `always`, `scheduled`

**Response (200):**

```json
{
  "success": true
}
```

---

## admin deployment apis

### list deployments

Returns deployments for a site, ordered by creation date.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/deployments?siteId=xxx&limit=20` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "deployments": [
    {
      "id": "deploy-1699564800000",
      "name": "TouchDesigner 2023",
      "installer_name": "TouchDesigner_099_2023.exe",
      "status": "completed",
      "createdAt": 1699564800000
    }
  ]
}
```

---

### create deployment

Creates a new deployment targeting specified machines.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/deployments` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "name": "TouchDesigner 2023",
  "installer_name": "TouchDesigner_099_2023.exe",
  "installer_url": "https://storage.googleapis.com/.../TouchDesigner_099_2023.exe",
  "silent_flags": "/VERYSILENT /NORESTART",
  "verify_path": "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe",
  "machineIds": ["DESKTOP-ABC123", "DESKTOP-DEF456"]
}
```

!!! note
    `installer_url` must be a valid HTTPS URL. HTTP, `file://`, and other protocols are rejected.

**Response (200):**

```json
{
  "success": true,
  "deploymentId": "deploy-1699564800000"
}
```

**Error (400) — Invalid URL:**

```json
{
  "error": "installer_url must use HTTPS protocol"
}
```

---

### get deployment status

Returns full deployment details including per-machine status.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/deployments/{deploymentId}?siteId=xxx` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "success": true,
  "deployment": {
    "id": "deploy-1699564800000",
    "name": "TouchDesigner 2023",
    "installer_name": "TouchDesigner_099_2023.exe",
    "installer_url": "https://storage.googleapis.com/.../TouchDesigner_099_2023.exe",
    "silent_flags": "/VERYSILENT /NORESTART",
    "verify_path": "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe",
    "status": "in_progress",
    "createdAt": 1699564800000,
    "targets": [
      { "machineId": "DESKTOP-ABC123", "status": "completed", "completedAt": 1699564850000 },
      { "machineId": "DESKTOP-DEF456", "status": "downloading", "progress": 45 }
    ]
  }
}
```

---

### delete deployment

Deletes a deployment record. Only allowed for deployments in terminal states (completed, failed, partial, cancelled, uninstalled).

| | |
|---|---|
| **Method** | `DELETE` |
| **URL** | `/api/admin/deployments/{deploymentId}?siteId=xxx` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "success": true
}
```

---

### cancel deployment

Cancels a running deployment for a specific machine. The target must exist in the deployment and be in a cancellable state (`pending`, `downloading`, or `installing`).

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/deployments/{deploymentId}/cancel` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "installer_name": "TouchDesigner_099_2023.exe"
}
```

**Response (200):**

```json
{
  "success": true,
  "commandId": "cancel_1699564850000_DESKTOP_ABC123"
}
```

**Error (400) — Machine not a target:**

```json
{
  "error": "Machine DESKTOP-XYZ is not a target of this deployment"
}
```

**Error (409) — Target already in terminal state:**

```json
{
  "error": "Cannot cancel target in \"completed\" state"
}
```

---

## admin installer apis

### get latest installer

Returns metadata for the latest available agent installer.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/installer/latest` |
| **Auth** | Session cookie (admin) or Firebase ID token |

**Response (200):**

```json
{
  "version": "2.1.8",
  "fileName": "OwletteSetup-2.1.8.exe",
  "downloadUrl": "https://storage.googleapis.com/...",
  "releaseNotes": "Bug fixes and performance improvements",
  "uploadedAt": "2026-03-20T10:00:00Z"
}
```

---

### list installer versions

Returns all available installer versions.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/installer/versions?limit=20` |
| **Auth** | Session cookie (admin) or Firebase ID token |

**Response (200):**

```json
{
  "versions": [
    {
      "version": "2.1.8",
      "fileName": "OwletteSetup-2.1.8.exe",
      "isLatest": true,
      "uploadedAt": "2026-03-20T10:00:00Z"
    }
  ]
}
```

---

### upload installer (initiate)

Initiates an installer upload and returns a signed upload URL.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/installer/upload` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "version": "2.1.9",
  "fileName": "OwletteSetup-2.1.9.exe",
  "releaseNotes": "New features and bug fixes",
  "setAsLatest": true
}
```

**Response (200):**

```json
{
  "uploadId": "upl_abc123",
  "signedUrl": "https://storage.googleapis.com/...?X-Goog-Signature=...",
  "expiresAt": "2026-03-22T12:30:00Z"
}
```

---

### upload installer (finalize)

Finalizes an installer upload after the binary has been uploaded to the signed URL.

| | |
|---|---|
| **Method** | `PUT` |
| **URL** | `/api/admin/installer/upload` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "uploadId": "upl_abc123",
  "checksum_sha256": "a1b2c3d4..."
}
```

**Response (200):**

```json
{
  "success": true,
  "version": "2.1.9"
}
```

---

## admin site apis

### list sites

Returns all sites accessible to the authenticated user.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/sites` |
| **Auth** | Session cookie (admin) or Firebase ID token |

**Response (200):**

```json
{
  "sites": [
    {
      "id": "nyc-office",
      "name": "NYC Office",
      "machineCount": 5
    }
  ]
}
```

---

## admin token apis

### list agent tokens

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/tokens/list?siteId=xxx` |
| **Auth** | Session cookie (admin) |

Returns all agent refresh tokens for a site.

---

### revoke agent tokens

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/tokens/revoke` |
| **Auth** | Session cookie (admin) |

**Request Body (revoke single):**

```json
{
  "siteId": "nyc-office",
  "tokenId": "hash_abc123"
}
```

**Request Body (revoke all for machine):**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123"
}
```

**Request Body (revoke all for site):**

```json
{
  "siteId": "nyc-office",
  "all": true
}
```

---

## admin log api

### get activity logs

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/logs?siteId=xxx&limit=50&action=process_crashed&level=error&machineId=xxx&since=timestamp` |
| **Auth** | Session cookie (admin) |

All query parameters except `siteId` are optional.

---

## admin event api

### simulate event

Trigger alert emails without requiring a real event.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/events/simulate` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "event": "process_crash",
  "data": {
    "machineId": "DESKTOP-TEST",
    "machineName": "Test Machine",
    "processName": "TouchDesigner",
    "errorMessage": "Simulated crash"
  }
}
```

**Event Types:** `process_crash`, `machine_offline`, `connection_failure`

---

## admin webhook apis

### list webhooks

Returns all configured webhooks for a site.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/webhooks?siteId=xxx` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "webhooks": [
    {
      "id": "wh_abc123",
      "name": "Slack Alerts",
      "url": "https://hooks.slack.com/services/...",
      "events": ["process_crash", "machine_offline"],
      "createdAt": "2026-03-20T10:00:00Z"
    }
  ]
}
```

---

### create webhook

Registers a new webhook endpoint for a site.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/webhooks` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "name": "Slack Alerts",
  "url": "https://hooks.slack.com/services/...",
  "events": ["process_crash", "machine_offline"]
}
```

**Response (200):**

```json
{
  "webhookId": "wh_abc123",
  "secret": "whsec_..."
}
```

The `secret` is used for verifying webhook payloads via HMAC signature. Shown once at creation time.

---

### delete webhook

Removes a webhook configuration.

| | |
|---|---|
| **Method** | `DELETE` |
| **URL** | `/api/admin/webhooks?siteId=xxx&webhookId=yyy` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "success": true
}
```

---

### test webhook

Sends a test payload to a configured webhook to verify connectivity.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/webhooks/test` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "webhookId": "wh_abc123",
  "siteId": "nyc-office"
}
```

**Response (200):**

```json
{
  "success": true,
  "status": 200
}
```

---

## admin api key apis

### list api keys

Returns all API keys for the authenticated admin.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/keys` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "keys": [
    {
      "id": "key_abc123",
      "name": "CI/CD Pipeline",
      "keyPrefix": "owk_abc1....",
      "createdAt": "2026-03-20T10:00:00Z",
      "lastUsedAt": "2026-03-21T14:30:00Z"
    }
  ]
}
```

---

### create api key

Generates a new API key. The full key is returned only once at creation time.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/admin/keys/create` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "name": "CI/CD Pipeline"
}
```

**Response (200):**

```json
{
  "key": "owk_abc123def456ghi789...",
  "keyId": "key_abc123"
}
```

The `key` value is shown **once** and cannot be retrieved again.

---

### revoke api key

Permanently revokes an API key.

| | |
|---|---|
| **Method** | `DELETE` |
| **URL** | `/api/admin/keys/revoke` |
| **Auth** | Session cookie (admin) |

**Request Body:**

```json
{
  "keyId": "key_abc123"
}
```

**Response (200):**

```json
{
  "success": true
}
```

---

## setup api

### generate token

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/setup/generate-token` |
| **Auth** | Session cookie |

**Request Body:**

```json
{
  "siteId": "nyc-office"
}
```

**Response (200):**

```json
{
  "token": "abc123def456",
  "siteId": "nyc-office",
  "userId": "uid123"
}
```

---

## cortex apis

### chat

Streaming chat endpoint with tool execution.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/cortex` |
| **Auth** | Session cookie |
| **Response** | Server-Sent Events (streaming) |

**Request Body:**

```json
{
  "messages": [{"role": "user", "content": "How's the system doing?"}],
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "machineName": "Gallery PC 1",
  "chatId": "chat-123"
}
```

Resolves LLM config (user key, then site key fallback). Streams response with tool calls and results.

---

### autonomous cortex

Internal endpoint for autonomous AI-driven event investigation. Called by the system when events occur (e.g., process crashes) to perform background analysis.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/cortex/autonomous` |
| **Auth** | `x-cortex-secret` header (internal) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "machineName": "Gallery PC 1",
  "eventType": "process_crash",
  "processName": "TouchDesigner",
  "errorMessage": "Process exited with code -1073741819"
}
```

**Response (200):**

```json
{
  "accepted": true,
  "eventId": "evt_abc123",
  "chatId": "chat-456"
}
```

Fire-and-forget. The background investigation runs asynchronously after the response is returned.

---

### provision cortex key

Provisions an LLM API key to a machine's local Cortex agent. Writes a command to Firestore and polls for completion.

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/cortex/provision-key` |
| **Auth** | Session cookie (user with site access) |

**Request Body:**

```json
{
  "siteId": "nyc-office",
  "machineId": "DESKTOP-ABC123",
  "apiKey": "sk-ant-...",
  "provider": "anthropic"
}
```

**Response (200):**

```json
{
  "success": true
}
```

**Error (504) — Timeout:**

```json
{
  "error": "Key provisioning timed out — machine may be offline"
}
```

---

### process escalations

Processes pending Cortex escalation flags and sends escalation emails to site admins. Called periodically by cron or triggered internally.

| | |
|---|---|
| **Method** | `POST` or `GET` |
| **URL** | `/api/cortex/escalation` |
| **Auth** | `x-cortex-secret` header (POST) or `Authorization: Bearer {CRON_SECRET}` (GET) |

**Response (200):**

```json
{
  "success": true,
  "processed": 2,
  "errors": 0
}
```

---

## llm settings apis

### user llm key

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/api/settings/llm-key` | Set user's LLM API key (encrypted) |
| `GET` | `/api/settings/llm-key` | Check if key is configured |
| `DELETE` | `/api/settings/llm-key` | Remove user's key |

### site llm key (admin)

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/api/settings/site-llm-key` | Set site's LLM API key (admin) |
| `GET` | `/api/settings/site-llm-key?siteId=xxx` | Check if site key is configured |
| `DELETE` | `/api/settings/site-llm-key` | Remove site's key |

---

## utility apis

### health check (cron)

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/cron/health-check` |
| **Auth** | `X-Cron-Secret` header |

Scans all machines for stale heartbeats. Sends email alerts. 1-hour cooldown per machine.

### test email

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/test-email` |
| **Auth** | Session cookie (admin) |

### user created webhook

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/webhooks/user-created` |
| **Auth** | Session or ID token |

Sends admin notification and optional welcome email when a new user registers.

### unsubscribe

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/unsubscribe?token=xxx` |
| **Auth** | HMAC-signed token |

One-click unsubscribe from health alert emails. Redirects to confirmation page.
