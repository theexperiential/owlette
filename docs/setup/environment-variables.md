# environment variables

Complete reference for all environment variables used by the owlette web dashboard.

---

## firebase client (required)

These are exposed to the browser (client-side). The `NEXT_PUBLIC_` prefix is required by Next.js.

| variable | example | source |
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

## firebase admin (required)

Server-side only — used for generating agent OAuth tokens and verifying sessions. Use three separate variables (not a JSON blob).

| variable | format | source |
|----------|--------|--------|
| `FIREBASE_PROJECT_ID` | `my-project-id` | Firebase Console → Project Settings → General |
| `FIREBASE_CLIENT_EMAIL` | `firebase-adminsdk-xxx@my-project.iam.gserviceaccount.com` | Firebase Console → Service Accounts → Generate Key |
| `FIREBASE_PRIVATE_KEY` | `"-----BEGIN PRIVATE KEY-----\n..."` | Same — keep the `\n` escape sequences |

!!! warning
    When setting `FIREBASE_PRIVATE_KEY` in Railway, wrap the value in double quotes and preserve the `\n` newline escapes exactly as exported from Firebase.

---

## session management (required)

| variable | format | description |
|----------|--------|-------------|
| `SESSION_SECRET` | 32+ character string | Encryption key for iron-session HTTPOnly cookies |
| `MFA_ENCRYPTION_KEY` | 32+ character string | Encryption key for 2FA secrets stored in Firestore |

Generate a secure value:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## email (required for alerts)

| variable | description |
|----------|-------------|
| `RESEND_API_KEY` | API key from [Resend](https://resend.com) for sending emails |
| `RESEND_FROM_EMAIL` | Verified sender address (e.g. `alerts@owlette.app`) |
| `ADMIN_EMAIL_PROD` | Fallback admin email address (production) |
| `ADMIN_EMAIL_DEV` | Fallback admin email address (development) |
| `SEND_WELCOME_EMAIL` | `true` or `false` — controls welcome emails to new users |

---

## rate limiting (required)

Owlette uses [Upstash](https://upstash.com) Redis for API rate limiting. Create a free Serverless Redis database and copy the REST connection details.

| variable | description |
|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | REST API URL for your Upstash Redis instance |
| `UPSTASH_REDIS_REST_TOKEN` | Authentication token for Upstash Redis |

---

## url configuration (required in production)

| variable | description |
|----------|-------------|
| `NEXT_PUBLIC_BASE_URL` | Public base URL used in email links and agent callbacks (e.g. `https://owlette.app`) |
| `RAILWAY_PUBLIC_DOMAIN` | Railway deployment domain — auto-injected by Railway, override if using a custom domain |

---

## cron (required for health checks)

| variable | description |
|----------|-------------|
| `CRON_SECRET` | Shared secret for authenticating cron health-check requests |

Generate:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## encryption (required for llm keys)

| variable | description |
|----------|-------------|
| `LLM_ENCRYPTION_KEY` | 32-byte hex key for encrypting stored LLM API keys |

Generate:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## autonomous cortex (optional)

| variable | description |
|----------|-------------|
| `CORTEX_INTERNAL_SECRET` | Shared secret for internal auth between alert route and autonomous Cortex endpoint |

Generate:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Required only if you want autonomous Cortex (AI auto-investigates process crashes). Also requires a site-level LLM API key configured in Firestore (`sites/{siteId}/settings/llm`) and autonomous mode enabled (`sites/{siteId}/settings/cortex` → `autonomousEnabled: true`).

---

## environment (auto-set)

| variable | value | set by |
|----------|-------|--------|
| `NODE_ENV` | `production` | `railway.toml` |
| `PORT` | `3000` | Railway (auto-injected) |

---

## summary

### minimum required

```env
# Firebase Client
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...

# Firebase Admin
FIREBASE_PROJECT_ID=my-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@my-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."

# Session
SESSION_SECRET=your-32-char-secret
MFA_ENCRYPTION_KEY=your-32-char-mfa-key

# Rate Limiting
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...

# URL
NEXT_PUBLIC_BASE_URL=https://your-app.railway.app
```

### full configuration

```env
# Firebase Client
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...

# Firebase Admin
FIREBASE_PROJECT_ID=my-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@my-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."

# Session
SESSION_SECRET=your-32-char-secret
MFA_ENCRYPTION_KEY=your-32-char-mfa-key

# Email
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=alerts@yourdomain.com
ADMIN_EMAIL_PROD=admin@yourdomain.com
ADMIN_EMAIL_DEV=dev@yourdomain.com
SEND_WELCOME_EMAIL=true

# Rate Limiting
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...

# URL
NEXT_PUBLIC_BASE_URL=https://owlette.app
RAILWAY_PUBLIC_DOMAIN=owlette.app

# Cron
CRON_SECRET=your-64-char-hex

# LLM Encryption
LLM_ENCRYPTION_KEY=your-64-char-hex

# Autonomous Cortex (optional)
CORTEX_INTERNAL_SECRET=your-64-char-hex
```

---

## security notes

- **Never commit** `.env.local` to git
- **Use Railway's Variables tab** — values are encrypted at rest
- **`NEXT_PUBLIC_*` prefix** means the value is exposed to the browser — only use for Firebase client config
- **Rotate secrets periodically** — especially `SESSION_SECRET` and `CRON_SECRET`
- **Separate environments** — use different Firebase projects for dev and production
