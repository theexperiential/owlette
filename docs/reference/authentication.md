# Authentication

owlette uses four authentication mechanisms: user auth (Firebase Auth), agent auth (device code pairing), passkey authentication (WebAuthn), and optional MFA (TOTP).

---

## User Authentication

### Sign-In Flow

```
Browser                     Firebase Auth              Dashboard API
  │                              │                          │
  │── signInWithEmail ──────────▶│                          │
  │   or signInWithGoogle        │                          │
  │                              │                          │
  │◀── Firebase ID Token ────────│                          │
  │                              │                          │
  │── POST /api/auth/session ───────────────────────────────▶│
  │   {idToken}                                             │
  │                                                         │── Verify ID token
  │                                                         │── Create iron-session
  │◀── Set-Cookie: session=... ─────────────────────────────│
  │   (HTTPOnly, encrypted)                                 │
  │                                                         │
  │── Subsequent requests use cookie ───────────────────────▶│
```

### Session Management

Sessions use [iron-session](https://github.com/vvo/iron-session) — encrypted, signed, HTTPOnly cookies.

| Property | Value |
|----------|-------|
| **Cookie name** | `session` |
| **HTTPOnly** | Yes (not accessible from JavaScript) |
| **Secure** | Yes (HTTPS only in production) |
| **Encryption** | AES-256-GCM via `SECRET_COOKIE_PASSWORD` |

### Sign-Out

`DELETE /api/auth/session` clears the session cookie.

---

## Agent Authentication (Device Code Pairing)

Agents authenticate using a device code flow with a two-token system. No Firebase service account keys are stored on client machines.

### Pairing Flow

```
1. Agent requests pairing phrase (POST /api/agent/auth/device-code)
   └── Server generates 3-word phrase (e.g., "silver-compass-drift")
       stored in device_codes/{phrase} with 10-minute expiry

2. User authorizes (POST /api/agent/auth/device-code/authorize)
   ├── Via browser auto-opened on the machine (owlette.app/add)
   ├── Via dashboard "+" button → "Enter Code" tab
   └── Via /ADD=phrase installer flag (pre-authorized, no interaction)

3. Agent polls for authorization (POST /api/agent/auth/device-code/poll)
   ├── Server creates Firebase custom token with claims:
   │     {role: "agent", site_id: "...", machine_id: "..."}
   ├── Server exchanges custom token for ID token (Firebase Auth REST)
   ├── Server generates refresh token (random, hashed in Firestore)
   └── Returns: accessToken + refreshToken + siteId

4. Agent stores tokens
   ├── Access token: used for Firestore REST API calls (1-hour expiry)
   └── Refresh token: encrypted locally with Fernet AES (machine-bound key)
```

### Token Refresh Flow

```
Agent detects token nearing expiry (~5 min before)
  │
  POST /api/agent/auth/refresh
  │  {refreshToken, machineId}
  │
  ├── Server validates: token hash exists in Firestore
  ├── Server validates: machineId matches token record
  ├── Server generates new custom token + ID token
  ├── Server updates lastUsed timestamp
  └── Returns: new customToken + idToken
```

### Token Security

| Aspect | Implementation |
|--------|---------------|
| **Refresh token storage** | Encrypted with Fernet AES, key derived from Windows `MachineGuid` |
| **Refresh token in Firestore** | Stored as SHA-256 hash (not plaintext) |
| **ID token lifetime** | 1 hour (Firebase custom token) |
| **Machine binding** | Refresh validates `machineId` matches — prevents token theft |
| **Token collections** | `device_codes`, `agent_tokens`, and `agent_refresh_tokens` are server-side only (no client access) |

### Custom Token Claims

```json
{
  "role": "agent",
  "site_id": "nyc-office",
  "machine_id": "DESKTOP-ABC123"
}
```

Firestore security rules use these claims to scope agent access to a single site and machine.

---

## Passkey Authentication (WebAuthn)

Passkeys use the Web Authentication API (FIDO2) for passwordless login. A passkey replaces both the password and 2FA — it's a single biometric/PIN step.

### Registration Flow

```
1. User is logged in, navigates to passkey management
   └── POST /api/passkeys/register/options
       ├── Generate WebAuthn registration challenge
       ├── Store in webauthn_challenges/{userId} (10-min expiry)
       └── Return PublicKeyCredentialCreationOptions

2. Browser prompts for authenticator (Touch ID, Windows Hello, phone)

3. User completes biometric/PIN
   └── POST /api/passkeys/register/verify
       ├── Verify attestation response
       ├── Store credential in users/{userId}/passkeys/{credentialId}
       ├── Set passkeyEnrolled: true on user document
       └── Delete challenge
```

### Login with Passkey

```
1. User clicks "passkey" on login page
   └── POST /api/passkeys/authenticate/options
       ├── Generate authentication challenge (discoverable)
       ├── Store in webauthn_challenges/{randomId} (10-min expiry)
       └── Return options + challengeId

2. Browser shows available passkeys for this site
   └── User selects and authenticates (biometric/PIN)

3. POST /api/passkeys/authenticate/verify
   ├── Verify assertion response against stored public key
   ├── Validate counter (clone detection)
   ├── Create iron-session (HTTPOnly cookie)
   ├── Create Firebase custom token
   ├── Client calls signInWithCustomToken()
   └── MFA is bypassed (passkey IS the second factor)
```

### Passkey Management

- Users can register multiple passkeys (e.g., laptop + phone)
- Each passkey has a friendly name, device type, creation date, last used date
- Rename: `PATCH /api/passkeys/{credentialId}`
- Delete: `DELETE /api/passkeys/{credentialId}`
- List: `GET /api/passkeys/list?userId=...`

### Security

| Aspect | Implementation |
|--------|---------------|
| **RP ID** | `owlette.app` (prod), `localhost` (dev) |
| **Challenge lifetime** | 10 minutes, single-use, deleted after verification |
| **Clone detection** | Counter validation — rejects if response counter ≤ stored counter |
| **Credential storage** | Public key in `users/{userId}/passkeys/` subcollection |
| **User verification** | `preferred` (allows both biometric and PIN) |
| **Discoverable credentials** | `residentKey: preferred` (no email needed to start login) |

---

## Multi-Factor Authentication (MFA)

Optional TOTP-based two-factor authentication. Passkey login bypasses MFA entirely.

### Setup Flow

```
1. User initiates 2FA setup
   └── POST /api/mfa/setup
       ├── Generate TOTP secret
       ├── Store in mfa_pending/{userId} (10-min expiry)
       └── Return secret + QR code URL

2. User scans QR with authenticator app

3. User enters 6-digit code
   └── POST /api/mfa/verify-setup
       ├── Verify code against secret
       ├── Encrypt secret → store in users/{userId}
       ├── Generate backup codes → hash and store
       └── Delete mfa_pending document

4. MFA is now active for this user

5. (Optional) User registers a passkey for faster future logins
```

### Login with MFA

```
1. User logs in normally (email/password or Google)
2. Dashboard detects mfaEnabled: true on user document
3. Prompt for TOTP code
4. POST /api/mfa/verify-login {code}
   ├── Decrypt secret from user document
   ├── Verify TOTP code (or check backup codes)
   ├── If backup code used: remove from list
   └── Return success
```

### Backup Codes

- 8 backup codes generated during setup
- Each is single-use
- Stored as hashed values in Firestore
- Used when authenticator device is unavailable

---

## Role-Based Access Control

### Roles

| Role | Access |
|------|--------|
| **user** | Assigned sites only, no admin features |
| **admin** | All sites, admin panel, user management |
| **agent** | Single site + single machine (custom token claims) |

### Enforcement Layers

1. **Firestore Security Rules** — Database-level enforcement (cannot be bypassed)
2. **API Route Middleware** — Server-side session and role verification
3. **React Components** — `RequireAdmin` component for client-side UI gating

### How Role is Determined

```
User logs in → Firebase Auth ID token
  │
  POST /api/auth/session → Server fetches users/{uid} from Firestore
  │
  └── role field → stored in session → available in AuthContext
```

---

## Security Architecture

```
                          ┌─────────────┐
                          │  Firebase    │
                          │  Auth        │
                          └──────┬──────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       │                  │                  │              │
┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐  ┌─────┴───────┐
│ User Auth    │  │ Agent Auth   │  │ MFA          │  │ Passkeys     │
│              │  │              │  │              │  │              │
│ Email/Google │  │ Custom Token │  │ TOTP         │  │ WebAuthn     │
│ → ID Token   │  │ + Refresh    │  │ + Backup     │  │ → Custom Tok │
│ → Session    │  │ → ID Token   │  │   Codes      │  │ → Session    │
└─────────────┘  └─────────────┘  └──────────────┘  └──────────────┘
       │                  │                                │
       ▼                  ▼                                ▼
       ┌───────────────────────────────────────────────────┐
       │  Firestore Security Rules (site-scoped, role-based)│
       └───────────────────────────────────────────────────┘
```
