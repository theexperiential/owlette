# Railway Deployment Guide - Owlette Web Dashboard

This guide explains how to deploy the Owlette web dashboard to Railway, a modern platform-as-a-service (PaaS) for hosting web applications.

## Overview

The Owlette web dashboard is a Next.js 16 application with Firebase integration for authentication and real-time data synchronization. Railway provides automatic deployment from GitHub with built-in CI/CD.

**Prerequisites:**
- GitHub repository access
- Railway account (sign up at [railway.app](https://railway.app))
- Firebase project configured (see [firebase-setup.md](firebase-setup.md))
- All 6 Firebase environment variables ready

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Railway Project Setup](#railway-project-setup)
3. [Environment Configuration](#environment-configuration)
4. [First Deployment](#first-deployment)
5. [Post-Deployment Configuration](#post-deployment-configuration)
6. [Troubleshooting](#troubleshooting)
7. [Continuous Deployment](#continuous-deployment)

---

## Pre-Deployment Checklist

### 1. Verify Local Build

Before deploying, ensure the application builds successfully locally:

```bash
cd web
npm install
npm run build
```

If the build fails, fix any TypeScript or build errors before proceeding.

### 2. Verify Railway Configuration

The repository includes a pre-configured [web/railway.toml](../web/railway.toml) file:

```toml
[build]
builder = "NIXPACKS"
buildCommand = "npm install && npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10

[env]
NODE_ENV = "production"
```

This configuration:
- Uses Nixpacks builder (Railway's automatic build system)
- Installs dependencies and builds Next.js app
- Starts production server on port 3000
- Restarts service automatically on failure (up to 10 retries)

### 3. Gather Firebase Configuration

You'll need these 6 environment variables from your Firebase project:

1. `NEXT_PUBLIC_FIREBASE_API_KEY`
2. `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
3. `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
4. `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
5. `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
6. `NEXT_PUBLIC_FIREBASE_APP_ID`

**Where to find them:**
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your Owlette project
3. Click Settings (gear icon) → Project Settings
4. Scroll to "Your apps" section
5. Select your web app or click "Add app" if none exists
6. Copy the config values from the Firebase SDK snippet

---

## Railway Project Setup

### Step 1: Create Railway Account

1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub (recommended for easy repo linking)
3. Verify your email address

### Step 2: Create New Project

1. Click "New Project" in Railway dashboard
2. Select "Deploy from GitHub repo"
3. Authorize Railway to access your GitHub account
4. Select the `Owlette` repository

### Step 3: Configure Deployment Settings

1. **Root Directory**: Set to `web` (since Owlette is a monorepo)
   - Click on your service
   - Go to "Settings" tab
   - Find "Root Directory" field
   - Enter: `web`

2. **Branch Configuration**: Set deployment branch
   - In "Settings" → "Source"
   - Select branch: `main` (or your production branch)
   - Enable "Auto-deploy on push" (optional but recommended)

3. **Service Name**: Rename for clarity
   - In "Settings" → "Service Name"
   - Change to: `owlette-web-dashboard`

---

## Environment Configuration

### Step 1: Add Firebase Variables

In the Railway dashboard:

1. Click on your service
2. Go to "Variables" tab
3. Click "New Variable" and add each of the following:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key_here
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
```

**Important Notes:**
- Copy values exactly as they appear in Firebase Console
- Do NOT include quotes around the values
- The `NEXT_PUBLIC_` prefix is required for client-side access in Next.js
- `NODE_ENV=production` is already set in `railway.toml`

### Step 2: Verify Variables

After adding all variables:

1. Click "Show All" to see all environment variables
2. Verify all 6 Firebase variables are present
3. Verify `NODE_ENV=production` exists (auto-added from railway.toml)

---

## First Deployment

### Trigger Deployment

Railway will automatically deploy after environment variables are configured:

**Automatic Trigger:**
- Railway detects changes and starts deployment automatically

**Manual Trigger:**
1. Go to "Deployments" tab
2. Click "Deploy" button
3. Select the branch to deploy

### Monitor Build Process

1. Click on the in-progress deployment
2. View real-time build logs
3. Look for these key milestones:
   - `Installing dependencies...` (npm install)
   - `Building Next.js application...` (npm run build)
   - `Starting production server...` (npm start)
   - `✓ Service deployed successfully`

**Expected Build Time:** 2-5 minutes

### Common Build Issues

**Build fails with "Missing environment variable"**
- Solution: Verify all 6 Firebase variables are set correctly
- The app validates environment variables at startup (see [web/lib/validateEnv.ts](../web/lib/validateEnv.ts))

**Build fails with TypeScript errors**
- Solution: Run `npm run build` locally first and fix errors
- TypeScript strict mode is enabled - all type errors must be resolved

**Build timeout**
- Solution: Check build logs for stuck processes
- Verify `package-lock.json` is committed (ensures consistent dependencies)

### Verify Deployment Success

After successful build:

1. Railway provides a deployment URL (e.g., `owlette-web-dashboard-production.up.railway.app`)
2. Click the URL to open your deployed dashboard
3. Verify the login page loads correctly
4. Check browser console for errors (F12 → Console)

---

## Post-Deployment Configuration

### Step 1: Update Firebase Authorized Domains

Firebase requires whitelisting domains for authentication:

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Navigate to: **Authentication** → **Settings** → **Authorized Domains**
4. Click "Add domain"
5. Add your Railway domain (e.g., `owlette-web-dashboard-production.up.railway.app`)
6. Click "Add"

**Without this step:** Users cannot log in - Firebase will reject authentication requests.

### Step 2: Test Authentication

1. Open your Railway deployment URL
2. Try to register a new user account
3. Verify email/password registration works
4. Test login with the new account
5. Verify redirect to dashboard after login

### Step 3: Configure Custom Domain (Optional)

If you have a custom domain:

1. In Railway dashboard, go to "Settings" → "Networking"
2. Click "Add Custom Domain"
3. Enter your domain (e.g., `owlette.yourdomain.com`)
4. Railway provides DNS instructions:
   - Add CNAME record pointing to Railway
   - Or add A record with provided IP
5. Wait for DNS propagation (5-60 minutes)
6. Railway automatically provisions SSL certificate (Let's Encrypt)

**After adding custom domain:**
- Add custom domain to Firebase Authorized Domains (repeat Step 1)
- Update any hardcoded URLs in your app (if any)

### Step 4: Set Up Health Checks (Optional)

Railway automatically detects Next.js health:

- Default: Checks port 3000 for HTTP response
- No additional configuration needed
- To customize, add health check endpoint in Next.js

---

## Troubleshooting

### Deployment Failed

**Check build logs:**
1. Go to "Deployments" tab
2. Click failed deployment
3. Read logs from bottom up (newest first)

**Common causes:**
- Missing environment variables
- TypeScript compilation errors
- Dependency installation failures
- Build timeout (large dependencies)

### Application Crashes After Deployment

**Symptoms:**
- Deployment succeeds but service restarts repeatedly
- "Service Unavailable" or 502 errors

**Solutions:**

1. **Check runtime logs:**
   ```
   Railway Dashboard → Deployments → [Latest] → View Logs
   ```

2. **Common issues:**
   - Environment variables not loaded: Verify in "Variables" tab
   - Port binding issue: Railway auto-injects `PORT` variable (Next.js uses 3000 by default)
   - Firebase initialization error: Check console logs for Firebase errors

3. **Verify environment validation:**
   - Look for: `ERROR: Missing required environment variables`
   - App validates env vars at startup in [web/lib/validateEnv.ts](../web/lib/validateEnv.ts)
   - In production, missing vars cause immediate crash (by design)

### Firebase Authentication Not Working

**Symptoms:**
- Login fails with "auth/unauthorized-domain"
- Redirect errors after login

**Solution:**
1. Verify Railway domain is in Firebase Authorized Domains
2. Clear browser cache and cookies
3. Check browser console for detailed Firebase errors
4. Verify Firebase config variables are correct

### Slow Performance

**Common causes:**
- Cold starts (Railway free tier spins down after inactivity)
- Large bundle size
- Firestore queries not optimized

**Solutions:**
1. **Upgrade Railway plan** (Pro tier has no cold starts)
2. **Optimize bundle:**
   ```bash
   npm run build
   # Check .next/static output size
   ```
3. **Add caching headers** in [next.config.ts](../web/next.config.ts)
4. **Optimize Firestore queries** (add indexes, limit results)

### SSL Certificate Issues

**Symptoms:**
- "Your connection is not private" warnings
- Mixed content errors

**Solutions:**
- Railway auto-provisions SSL - wait 5-10 minutes after domain setup
- For custom domains: Verify DNS CNAME/A record is correct
- Check domain DNS propagation: [whatsmydns.net](https://www.whatsmydns.net)

### Environment Variables Not Updating

**Symptom:**
- Changed variables but app still uses old values

**Solution:**
1. Update variables in Railway dashboard
2. **Redeploy required**: Variables only update on new deployment
3. Manually trigger redeploy:
   - "Deployments" tab → "Deploy" button
   - Or push a commit to trigger auto-deploy

---

## Continuous Deployment

### Automatic Deployment on Git Push

Railway automatically deploys when you push to the configured branch:

1. Make changes locally in `web/` directory
2. Commit changes: `git add . && git commit -m "Update dashboard"`
3. Push to main branch: `git push origin main`
4. Railway detects push and starts deployment automatically
5. Monitor in Railway dashboard "Deployments" tab

**Deployment Triggers:**
- Push to `main` (or configured branch)
- Changes in `web/` directory only (root directory filter)
- `railway.toml` configuration changes

### Branch Deployments

Create preview deployments for testing:

1. Create feature branch: `git checkout -b feature/new-feature`
2. Make changes and push: `git push origin feature/new-feature`
3. In Railway, click "New Service" → "Deploy from GitHub"
4. Select same repo but different branch
5. Railway creates separate preview deployment

**Use cases:**
- Test changes before merging to main
- Demo features to stakeholders
- Run integration tests in production-like environment

### Rollback to Previous Deployment

If a deployment causes issues:

1. Go to "Deployments" tab
2. Find last working deployment
3. Click "⋮" menu → "Redeploy"
4. Railway restores previous version

**Or via Git:**
```bash
git revert HEAD
git push origin main
```

---

## Monitoring & Logs

### View Real-Time Logs

```
Railway Dashboard → Service → Deployments → [Latest] → View Logs
```

**Log types:**
- Build logs: npm install, build process
- Runtime logs: Next.js server, application errors
- System logs: Service restarts, crashes

### Set Up Notifications

1. Go to "Settings" → "Notifications"
2. Enable:
   - Deployment success/failure
   - Service crashes
   - Build errors
3. Choose notification method:
   - Email
   - Discord webhook
   - Slack webhook

### Metrics Dashboard

Railway provides metrics:
- CPU usage
- Memory usage
- Network traffic
- Request rate

**Access:** Service → "Metrics" tab

---

## Cost Optimization

### Railway Pricing (as of 2025)

- **Hobby Plan**: $5/month
  - 500 hours execution time
  - $0.000463/GB-hour memory
  - $0.10/GB network egress

- **Pro Plan**: $20/month
  - Unlimited execution time
  - No cold starts
  - Priority support

### Optimization Tips

1. **Use Hobby Plan for Development**
   - Deploy to Railway Hobby for staging
   - Use separate Pro account for production

2. **Optimize Bundle Size**
   - Smaller bundle = faster cold starts
   - Run `npm run build` and check `.next/static` size

3. **Implement Caching**
   - Cache static assets
   - Use Next.js Image Optimization
   - Add CDN for static files (Cloudflare)

---

## Security Best Practices

### Environment Variables

✅ **Do:**
- Use Railway's "Variables" tab (encrypted at rest)
- Never commit `.env.local` to Git
- Use `NEXT_PUBLIC_` prefix only for client-side vars
- Rotate Firebase credentials periodically

❌ **Don't:**
- Hardcode secrets in code
- Share Firebase service account keys (those are for agent only)
- Use same Firebase project for dev/prod

### Firebase Security

1. **Firestore Security Rules**: Ensure rules restrict access by user/site
2. **Authorized Domains**: Only whitelist your production domains
3. **API Key Restrictions**: Configure in Google Cloud Console
4. **Enable App Check**: Prevent abuse (optional but recommended)

### Next.js Security

The app includes security headers in [next.config.ts](../web/next.config.ts):
- X-Frame-Options: DENY
- Content-Security-Policy (allows Firebase domains)
- X-Content-Type-Options: nosniff
- Referrer-Policy: origin-when-cross-origin

**Review these headers** if you add third-party integrations.

---

## Advanced Configuration

### Custom Build Command

To customize build process, edit [web/railway.toml](../web/railway.toml):

```toml
[build]
buildCommand = "npm install && npm run custom-build"
```

Then add custom script to `package.json`:
```json
{
  "scripts": {
    "custom-build": "npm run build && npm run post-build-script"
  }
}
```

### Database Connection (Future)

If you add a database (PostgreSQL, Redis):

1. In Railway, click "New" → "Database"
2. Railway provides connection string as environment variable
3. Access in Next.js via `process.env.DATABASE_URL`

### Background Jobs / Cron Health Checks

Owlette uses a Railway Cron Job to poll all machines every 5 minutes and send email alerts when a machine goes offline without reporting in. The cron calls `GET /api/cron/health-check` with a shared secret header.

#### Setup (do this for both dev and prod Railway services)

**Step 1 — Add `CRON_SECRET` environment variable**

Generate a random secret locally:
```bash
# Windows (Python — already installed with Owlette)
python -c "import secrets; print(secrets.token_hex(32))"

# macOS/Linux
openssl rand -hex 32
```
Add it as a Railway variable named `CRON_SECRET` in the **Variables** tab of your web service. Railway automatically shares variables with Cron Job services in the same project.

**Step 2 — Enable the built-in Railway cron schedule**

Railway has a built-in cron scheduler on every service — no separate service or third-party tool needed.

1. In the Railway dashboard, open your **owlette-dev** (or **owlette-prod**) service
2. Go to **Settings** tab and search for **"Cron Schedule"**
3. Enter the schedule: `*/5 * * * *`
   > ⚠️ Use spaces between the 5 fields — `*/5****` (no spaces) will fail with "Expected 5 values, but got 1"
4. Save — Railway will call your service's start command on this schedule

> **Note:** The Railway cron runs the service's start command on schedule. The `GET /api/cron/health-check` endpoint handles the actual work; Railway just wakes the service on the schedule.

**What it does:**
- Scans all `sites/{siteId}/machines/{machineId}` docs for stale heartbeats (> 3 minutes old)
- Sends one grouped email per site via Resend when offline machines are found
- Writes `health.lastCronAlertAt` to Firestore to prevent repeat emails within 1 hour per machine

**Env vars required for this feature:**
| Variable | Purpose |
|----------|---------|
| `CRON_SECRET` | Shared secret for cron auth (generate with Python: `secrets.token_hex(32)`) |
| `RESEND_API_KEY` | Already required for other emails |
| `ADMIN_EMAIL_PROD` / `ADMIN_EMAIL_DEV` | Fallback recipient if no site users found |

---

## Deployment Checklist

Use this checklist for every deployment:

### Pre-Deployment
- [ ] Local build succeeds: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] TypeScript has no errors: `npx tsc --noEmit`
- [ ] Environment variables documented in `.env.example`
- [ ] Firebase project configured and authorized domains set

### Railway Setup
- [ ] Railway project created
- [ ] Repository linked to Railway
- [ ] Root directory set to `web`
- [ ] Deployment branch configured (usually `main`)
- [ ] All 6 Firebase environment variables added
- [ ] `NODE_ENV=production` verified (auto-set by railway.toml)
- [ ] `CRON_SECRET` variable added (use `python -c "import secrets; print(secrets.token_hex(32))"` on Windows)
- [ ] Cron schedule configured (Railway Settings → "Cron Schedule" field → `*/5 * * * *`) with `X-Cron-Secret` header passed via env var

### First Deployment
- [ ] Deployment triggered (automatic or manual)
- [ ] Build logs reviewed for errors
- [ ] Deployment succeeded with green status
- [ ] Deployment URL accessible
- [ ] Login page loads without console errors

### Post-Deployment
- [ ] Railway domain added to Firebase Authorized Domains
- [ ] User registration tested
- [ ] User login tested
- [ ] Dashboard loads and shows data
- [ ] Real-time updates working (machines, deployments)
- [ ] Custom domain configured (if applicable)
- [ ] SSL certificate active (HTTPS)

### Monitoring
- [ ] Deployment notifications configured
- [ ] Error tracking set up (optional: Sentry, LogRocket)
- [ ] Performance monitoring enabled
- [ ] Uptime monitoring configured (optional: UptimeRobot)

---

## Related Documentation

- [Firebase Setup Guide](firebase-setup.md) - Configure Firebase project
- [Architecture Decisions](architecture-decisions.md) - System design overview
- [Web README](../web/README.md) - Local development setup
- [Agent Deployment Guide](deployment.md) - Deploy Windows agent

---

## Support & Resources

### Railway Documentation
- [Railway Docs](https://docs.railway.app/)
- [Next.js on Railway](https://docs.railway.app/guides/nextjs)
- [Environment Variables](https://docs.railway.app/develop/variables)

### Owlette Resources
- [GitHub Repository](https://github.com/yourusername/Owlette)
- [CLAUDE.md](.claude/CLAUDE.md) - Development guide

### Community
- Railway Discord: [discord.gg/railway](https://discord.gg/railway)
- Railway GitHub: [github.com/railwayapp](https://github.com/railwayapp)

---

**Last Updated:** 2025-11-02
**Railway Version:** v2 (Nixpacks)
**Next.js Version:** 16.0.1
