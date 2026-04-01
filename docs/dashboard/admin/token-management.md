# Token Management

View and revoke agent OAuth tokens. Each agent has a refresh token that allows it to authenticate with Firestore.

**Location**: Admin Panel → Token Management (`/admin/tokens`)

---

## Token List

The token management page shows all active agent refresh tokens for a site:

| Column | Description |
|--------|-------------|
| **Machine ID** | The machine's hostname |
| **Agent UID** | Firebase UID assigned to the agent |
| **Created** | When the token was issued |
| **Last Used** | When the agent last refreshed its access token |
| **Version** | Agent version that created the token |

---

## Token Lifecycle

```
1. Admin generates registration code (24h expiry)
2. Agent exchanges code for tokens:
   ├── Custom Firebase Token (1-hour access token)
   └── Refresh Token (long-lived)
3. Agent stores refresh token encrypted locally
4. Every ~55 minutes: agent refreshes access token
5. Server updates lastUsed timestamp
```

---

## Revoking Tokens

### Revoke Single Token

1. Find the token in the list
2. Click **"Revoke"**
3. The agent loses access and goes offline

### Revoke All Tokens for a Machine

If a machine has multiple tokens (e.g., from reinstallation):

1. Click **"Revoke All"** for the machine
2. All tokens for that machine ID are deleted

### Revoke All Tokens for a Site

Nuclear option — revokes every agent token for the site:

1. Click **"Revoke All Site Tokens"**
2. Confirm the action
3. **All agents** in the site lose access and go offline

!!! warning "After revocation"
    Revoked agents must be re-registered with a new registration code to reconnect.

---

## When to Revoke

- **Decommissioning a machine** — Revoke its token to clean up
- **Security concern** — If a machine is compromised, revoke immediately
- **Duplicate tokens** — If a machine was reinstalled and has stale tokens
- **Debugging** — Force an agent to re-authenticate
