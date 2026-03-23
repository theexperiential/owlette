# REST API Reference

All HTTP endpoints exposed by the Owlette web dashboard. 46 route files under `web/app/api/`, producing **~60 distinct method+path combinations**.

---

## Table of Contents

- [Authentication APIs](#authentication-apis) (3 endpoints)
- [MFA APIs](#mfa-apis) (3 endpoints)
- [Passkey APIs](#passkey-apis) (7 endpoints)
- [Agent Authentication APIs](#agent-authentication-apis) (3 endpoints)
- [Agent Alert API](#agent-alert-api) (1 endpoint)
- [Agent Screenshot API](#agent-screenshot-api) (1 endpoint)
- [Admin Machine APIs](#admin-machine-apis) (2 endpoints)
- [Admin Command API](#admin-command-api) (1 endpoint)
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
- [Cortex APIs](#cortex-apis) (2 endpoints)
- [LLM Settings APIs](#llm-settings-apis) (6 endpoints)
- [Utility APIs](#utility-apis) (4 endpoints)

---

## Authentication APIs

### Create Session

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

### Destroy Session

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

### Get Session Status

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

## MFA APIs

### Setup MFA

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
  "qrCodeUrl": "otpauth://totp/Owlette:user@example.com?secret=..."
}
```

Stores pending setup in Firestore `mfa_pending/{userId}` with 10-minute expiry.

---

### Verify MFA Setup

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

### Verify MFA Login

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

## Passkey APIs

### Register Passkey Options

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

### Register Passkey Verify

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

### Authenticate Passkey Options

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

### Authenticate Passkey Verify

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

### List Passkeys

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

### Rename Passkey

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

### Delete Passkey

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

## Agent Authentication APIs

### Exchange Registration Code

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

### Refresh Access Token

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

### Generate Installer

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

## Agent Alert API

### Send Alert

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

## Agent Screenshot API

### Upload Screenshot

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

## Admin Machine APIs

### List Machines

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

### Get Machine Status

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/machines/status?siteId=xxx&machineId=xxx` |
| **Auth** | Session cookie (admin) |

Returns detailed machine info including metrics, processes, health, and agent version.

---

## Admin Command API

### Send Command

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

## Admin Process APIs

### List Processes

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

### Add Process

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

### Update Process

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

### Delete Process

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

### Update Process Launch Mode

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

## Admin Deployment APIs

### List Deployments

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
      "id": "dep_abc123",
      "name": "TouchDesigner 2023",
      "installer_name": "TouchDesigner_099_2023.exe",
      "status": "completed",
      "createdAt": "2026-03-20T10:00:00Z"
    }
  ]
}
```

---

### Create Deployment

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

**Response (200):**

```json
{
  "deploymentId": "dep_abc123"
}
```

---

### Get Deployment Status

Returns full deployment details including per-machine status.

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/deployments/{deploymentId}?siteId=xxx` |
| **Auth** | Session cookie (admin) |

**Response (200):**

```json
{
  "id": "dep_abc123",
  "name": "TouchDesigner 2023",
  "status": "in_progress",
  "machines": {
    "DESKTOP-ABC123": { "status": "completed", "completedAt": "2026-03-20T10:05:00Z" },
    "DESKTOP-DEF456": { "status": "downloading", "progress": 45 }
  }
}
```

---

### Delete Deployment

Deletes a deployment record. Only allowed for deployments in terminal states (completed, failed, cancelled).

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

### Cancel Deployment

Cancels a running deployment for a specific machine.

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
  "success": true
}
```

---

## Admin Installer APIs

### Get Latest Installer

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

### List Installer Versions

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

### Upload Installer (Initiate)

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

### Upload Installer (Finalize)

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

## Admin Site APIs

### List Sites

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

## Admin Token APIs

### List Agent Tokens

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/tokens/list?siteId=xxx` |
| **Auth** | Session cookie (admin) |

Returns all agent refresh tokens for a site.

---

### Revoke Agent Tokens

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

## Admin Log API

### Get Activity Logs

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/logs?siteId=xxx&limit=50&action=process_crashed&level=error&machineId=xxx&since=timestamp` |
| **Auth** | Session cookie (admin) |

All query parameters except `siteId` are optional.

---

## Admin Event API

### Simulate Event

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

## Admin Webhook APIs

### List Webhooks

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

### Create Webhook

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

### Delete Webhook

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

### Test Webhook

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

## Admin API Key APIs

### List API Keys

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

### Create API Key

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

### Revoke API Key

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

## Setup API

### Generate Token

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

## Cortex APIs

### Chat

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

### Autonomous Cortex

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

## LLM Settings APIs

### User LLM Key

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/api/settings/llm-key` | Set user's LLM API key (encrypted) |
| `GET` | `/api/settings/llm-key` | Check if key is configured |
| `DELETE` | `/api/settings/llm-key` | Remove user's key |

### Site LLM Key (Admin)

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/api/settings/site-llm-key` | Set site's LLM API key (admin) |
| `GET` | `/api/settings/site-llm-key?siteId=xxx` | Check if site key is configured |
| `DELETE` | `/api/settings/site-llm-key` | Remove site's key |

---

## Utility APIs

### Health Check (Cron)

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/cron/health-check` |
| **Auth** | `X-Cron-Secret` header |

Scans all machines for stale heartbeats. Sends email alerts. 1-hour cooldown per machine.

### Test Email

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/test-email` |
| **Auth** | Session cookie (admin) |

### User Created Webhook

| | |
|---|---|
| **Method** | `POST` |
| **URL** | `/api/webhooks/user-created` |
| **Auth** | Session or ID token |

Sends admin notification and optional welcome email when a new user registers.

### Unsubscribe

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/unsubscribe?token=xxx` |
| **Auth** | HMAC-signed token |

One-click unsubscribe from health alert emails. Redirects to confirmation page.
