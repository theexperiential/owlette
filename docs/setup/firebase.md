# Firebase Setup

Firebase provides the real-time database (Firestore) and authentication backend for Owlette.

---

## Step 1: Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **"Add project"**
3. Name it (e.g., "Owlette" or "Owlette-Dev")
4. Disable Google Analytics (not needed)
5. Click **"Create Project"**

---

## Step 2: Enable Firestore Database

1. In Firebase Console, click **"Firestore Database"** in the left sidebar
2. Click **"Create database"**
3. Select **"Start in Production mode"** (security rules will be configured next)
4. Choose a location close to your users (e.g., `us-central1`, `us-east1`)
5. Click **"Enable"**

---

## Step 3: Enable Authentication

1. Click **"Authentication"** in the left sidebar
2. Click **"Get started"**
3. Enable sign-in providers:
    - **Email/Password** — Toggle on
    - **Google** — Toggle on, configure OAuth consent screen

---

## Step 4: Get Web App Configuration

1. In Firebase Console → Project Settings (gear icon)
2. Scroll to **"Your apps"**
3. Click **"Add app"** → Select **Web** (&lt;/&gt; icon)
4. Register the app (name: "Owlette Dashboard")
5. Copy the 6 configuration values:

```javascript
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

These become your `NEXT_PUBLIC_FIREBASE_*` environment variables.

---

## Step 5: Generate Service Account Key

The web dashboard's server-side API routes need a service account key for generating agent OAuth tokens.

1. In Firebase Console → Project Settings → **"Service accounts"** tab
2. Click **"Generate new private key"**
3. Save the downloaded JSON file

!!! danger "Keep this secret"
    Never commit the service account key to git. Store it as an environment variable (`FIREBASE_SERVICE_ACCOUNT_KEY`) in your deployment platform.

The entire JSON content is set as a single environment variable. Railway and other platforms support multi-line values.

---

## Step 6: Enable Firebase Storage (Optional)

Required for installer version management:

1. Click **"Storage"** in the left sidebar
2. Click **"Get started"**
3. Start in Production mode
4. Deploy storage rules from `storage.rules` in the repository

---

## Step 7: Deploy Security Rules & Indexes

See [Firestore Rules](firestore-rules.md) for detailed deployment instructions.

**Quick deploy with Firebase CLI:**

```bash
npm install -g firebase-tools
firebase login
firebase use --add  # Select your project
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

!!! important "Indexes are required"
    Composite indexes (defined in `firestore.indexes.json`) must be deployed for features like Cortex conversation history and autonomous event queries to work. Without them, queries will fail with a "requires an index" error.

---

## Multi-User Access Control

Owlette enforces site-based access at the Firestore security rules level:

| Role | Access |
|------|--------|
| **Site creators** | Automatically assigned as owner with full access |
| **Regular users** | Can only access sites in their `sites` array |
| **Admins** | Can access all sites |
| **Agents** | Scoped to single site + machine via custom token claims |

Security rules check permissions on every read/write — no client-side bypass is possible.

---

## Firestore Data Structure

```
sites/{siteId}/
  ├── name, createdAt, owner
  └── machines/{machineId}/
      ├── presence/    (heartbeat every 30s)
      ├── status/      (metrics every 60s)
      └── commands/    (pending/ + completed/)

config/{siteId}/machines/{machineId}/
  ├── version, processes[]

users/{userId}/
  ├── email, role, sites[], createdAt

agent_tokens/{registrationCode}/
agent_refresh_tokens/{tokenHash}/
activity_logs/{logId}/
installer_metadata/
```

!!! info "Complete schema"
    See [Firestore Data Model](../reference/firestore-data-model.md) for all fields and types.

---

## Troubleshooting

### Can't find "Rules" tab in Firestore

Make sure you've created the Firestore database first (Step 2). Look for tabs at the top: Data | Rules | Indexes | Usage.

### "Permission denied" errors

1. Verify security rules are published (Step 7)
2. Check that the user is authenticated
3. Check the user has access to the site
4. Review the Rules Playground in Firebase Console for specific test scenarios

### Service account key not downloading

- Check your browser's download folder
- Try a different browser (Chrome recommended)
- Ensure pop-ups are not blocked
