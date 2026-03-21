# Environment Variables

Complete reference for all environment variables used by the Owlette web dashboard.

---

## Firebase Client (Required)

These are exposed to the browser (client-side). The `NEXT_PUBLIC_` prefix is required by Next.js.

| Variable | Example | Source |
|----------|---------|--------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `AIzaSy...` | Firebase Console → Project Settings → Web App |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `my-project.firebaseapp.com` | Same |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `my-project-id` | Same |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `my-project.appspot.com` | Same |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `123456789012` | Same |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `1:123:web:abc` | Same |

!!! note
    These values are public by design — Firebase client SDKs are designed to be used in browsers. Security is enforced by Firestore security rules, not by keeping these values secret.

---

## Firebase Admin (Required)

Server-side only — used for generating agent OAuth tokens and verifying sessions.

| Variable | Format | Source |
|----------|--------|--------|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | JSON string (entire service account file) | Firebase Console → Service Accounts → Generate Key |

Set the entire JSON content as a single environment variable. Railway supports multi-line values.

---

## Session Management (Required)

| Variable | Format | Description |
|----------|--------|-------------|
| `SECRET_COOKIE_PASSWORD` | 32+ character string | Encryption key for iron-session HTTPOnly cookies |

Generate a secure password:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## Email (Required for Alerts)

| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | API key from [Resend](https://resend.com) for sending emails |
| `ADMIN_EMAIL_PROD` | Fallback admin email address (production) |
| `ADMIN_EMAIL_DEV` | Fallback admin email address (development) |

---

## Cron (Required for Health Checks)

| Variable | Description |
|----------|-------------|
| `CRON_SECRET` | Shared secret for authenticating cron health-check requests |

Generate:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## Encryption (Required for LLM Keys)

| Variable | Description |
|----------|-------------|
| `LLM_ENCRYPTION_KEY` | 32-byte hex key for encrypting stored LLM API keys |

Generate:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## Autonomous Cortex (Optional)

| Variable | Description |
|----------|-------------|
| `CORTEX_INTERNAL_SECRET` | Shared secret for internal auth between alert route and autonomous Cortex endpoint |

Generate:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Required only if you want autonomous Cortex (AI auto-investigates process crashes). Also requires a site-level LLM API key configured in Firestore (`sites/{siteId}/settings/llm`) and autonomous mode enabled (`sites/{siteId}/settings/cortex` → `autonomousEnabled: true`).

---

## Environment (Auto-Set)

| Variable | Value | Set By |
|----------|-------|--------|
| `NODE_ENV` | `production` | `railway.toml` |
| `PORT` | `3000` | Railway (auto-injected) |

---

## Summary

### Minimum Required

```env
# Firebase Client
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...

# Firebase Admin
FIREBASE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}

# Session
SECRET_COOKIE_PASSWORD=your-32-char-secret
```

### Full Configuration

```env
# Firebase Client
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...

# Firebase Admin
FIREBASE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}

# Session
SECRET_COOKIE_PASSWORD=your-32-char-secret

# Email
RESEND_API_KEY=re_...
ADMIN_EMAIL_PROD=admin@yourdomain.com
ADMIN_EMAIL_DEV=dev@yourdomain.com

# Cron
CRON_SECRET=your-64-char-hex

# LLM Encryption
LLM_ENCRYPTION_KEY=your-64-char-hex

# Autonomous Cortex (optional)
CORTEX_INTERNAL_SECRET=your-64-char-hex
```

---

## Security Notes

- **Never commit** `.env.local` to git
- **Use Railway's Variables tab** — values are encrypted at rest
- **`NEXT_PUBLIC_*` prefix** means the value is exposed to the browser — only use for Firebase client config
- **Rotate secrets periodically** — especially `SECRET_COOKIE_PASSWORD` and `CRON_SECRET`
- **Separate environments** — use different Firebase projects for dev and production
