# Web Deployment

The Owlette dashboard is a Next.js application. This guide covers deploying to Railway (recommended) and general Node.js hosting.

---

## Railway Deployment (Recommended)

### Step 1: Create Railway Project

1. Go to [railway.app](https://railway.app) and sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select the Owlette repository

### Step 2: Configure Service

1. Click on your service → **Settings**
2. Set **Root Directory**: `web`
3. Set **Branch**: `main` (production) or `dev` (development)
4. Enable **"Auto-deploy on push"**

The repository includes `web/railway.toml` with build configuration:

```toml
[build]
builder = "NIXPACKS"
buildCommand = "npm install && npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

### Step 3: Add Environment Variables

In Railway → your service → **Variables** tab, add all variables listed in [Environment Variables](environment-variables.md).

### Step 4: Deploy

Railway deploys automatically after variables are configured. Monitor the build in the **Deployments** tab.

**Expected build time**: 2-5 minutes.

### Step 5: Configure Firebase Auth Domain

1. Copy your Railway deployment URL
2. Go to Firebase Console → Authentication → Settings → **Authorized Domains**
3. Add your Railway URL (e.g., `owlette-web.up.railway.app`)

!!! warning "Required"
    Without this step, users cannot log in — Firebase rejects auth requests from unauthorized domains.

### Step 6: Custom Domain (Optional)

1. Railway → Settings → Networking → **"Add Custom Domain"**
2. Add CNAME or A record as instructed
3. Railway auto-provisions SSL via Let's Encrypt
4. Add the custom domain to Firebase Authorized Domains too

---

## Cron Health Checks

Set up the machine offline detection cron:

### Step 1: Add CRON_SECRET

```bash
# Generate a secret
python -c "import secrets; print(secrets.token_hex(32))"
```

Add as `CRON_SECRET` in Railway Variables.

### Step 2: Configure Cron Schedule

1. Railway → your service → Settings → **"Cron Schedule"**
2. Enter: `*/5 * * * *` (every 5 minutes)

!!! warning "Format"
    Use spaces between fields: `*/5 * * * *`. No spaces (`*/5****`) will fail.

---

## Two-Branch Deployment

Owlette uses two branches with separate Railway deployments:

| Branch | Deployment | URL |
|--------|-----------|-----|
| `dev` | Development | `dev.owlette.app` |
| `main` | Production | `owlette.app` |

Each has its own Railway service, environment variables, and (optionally) Firebase project.

---

## General Node.js Hosting

For non-Railway deployments:

```bash
cd web
npm install
npm run build
npm start
```

**Requirements:**

- Node.js 18+
- All environment variables set
- Port 3000 available (or set `PORT` env var)
- HTTPS for Firebase Auth (required)

---

## Deployment Checklist

### Pre-Deployment

- [ ] `npm run build` succeeds locally
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` has no errors
- [ ] All environment variables documented

### Railway Setup

- [ ] Repository linked
- [ ] Root directory set to `web`
- [ ] Branch configured
- [ ] All environment variables added
- [ ] `CRON_SECRET` configured
- [ ] Cron schedule set (`*/5 * * * *`)

### Post-Deployment

- [ ] Railway domain added to Firebase Authorized Domains
- [ ] Registration works
- [ ] Login works
- [ ] Dashboard loads and shows data
- [ ] Real-time updates working
- [ ] Custom domain configured (if applicable)

---

## Troubleshooting

### Build Fails

- **Missing env var**: Verify all `NEXT_PUBLIC_*` variables are set
- **TypeScript errors**: Run `npm run build` locally first
- **Dependency issues**: Ensure `package-lock.json` is committed

### App Crashes After Deploy

- Check runtime logs in Railway Deployments tab
- Look for env var validation errors (`ERROR: Missing required environment variables`)
- Verify Firebase config values are correct (no quotes around values)

### Auth Not Working

- Add Railway domain to Firebase Authorized Domains
- Clear browser cache and cookies
- Check browser console for Firebase error details

### Slow Performance

- **Cold starts**: Upgrade to Railway Pro (no cold starts)
- **Bundle size**: Run `npm run build` and check `.next/static` output
- **Firestore queries**: Add indexes for frequently queried fields

---

## Cost

### Railway Pricing

| Plan | Cost | Key Features |
|------|------|-------------|
| **Hobby** | $5/month | 500 hours, cold starts |
| **Pro** | $20/month | Unlimited, no cold starts, priority support |

### Optimization

- Use Hobby for development, Pro for production
- Optimize bundle size for faster cold starts
- Add CDN (Cloudflare) for static assets
