# REST API Reference

All HTTP endpoints exposed by the Owlette web dashboard. Endpoints are Next.js API routes under `web/app/api/`.

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

## Admin APIs

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

### Get Activity Logs

| | |
|---|---|
| **Method** | `GET` |
| **URL** | `/api/admin/logs?siteId=xxx&limit=50&action=process_crashed&level=error&machineId=xxx&since=timestamp` |
| **Auth** | Session cookie (admin) |

All query parameters except `siteId` are optional.

---

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

## Cortex API

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
