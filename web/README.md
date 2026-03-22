# Owlette Web Portal

Next.js 16 web portal for managing Windows processes via Owlette agents.

## Features

- **Firebase Authentication** (Email/Password, Google OAuth, Passkeys/WebAuthn, 2FA/TOTP)
- **Real-time dashboard** with live metrics
- **Machine management** and monitoring
- **Process configuration** from the web
- **Remote screenshots** from managed machines
- **Bidirectional sync** with Owlette agents
- **Remote software deployment** and project distribution
- **Activity logs** and event tracking
- **Cortex AI** - LLM-powered assistant for fleet management
- **Admin panel** - User management, installers, presets, tokens, webhooks, email alerts
- **Email notifications** via Resend

## Getting Started

### Prerequisites

- Node.js 18+
- Firebase project with Firestore enabled
- Firebase Authentication enabled (Email/Password + Google)
- Upstash Redis account (free tier available - for rate limiting)
- Resend account (optional - for email notifications)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```

3. Add your Firebase credentials to `.env.local`:

**Client-Side Config** (Firebase Console -> Project Settings -> General -> Your apps -> Web app):
```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789012
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789012:web:abcdef123456
```

**Server-Side Admin SDK** (Firebase Console -> Project Settings -> Service Accounts -> Generate new private key):
```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBA...(full key here)...\n-----END PRIVATE KEY-----"
```

> **Note:** The Admin SDK credentials are required for OAuth agent authentication (custom token generation).

**Session Secret** (Generate with `openssl rand -base64 32`):
```env
SESSION_SECRET=your-super-secret-session-key-min-32-chars-here
```

> **Security:** Use a different secret for development and production!

**Upstash Redis** (Create free account at https://upstash.com):
```env
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
```

> **Note:** Rate limiting will be disabled if these are not configured. The app will still work, but won't have brute-force protection.

**Resend Email** (Optional - for user notifications):
```env
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
RESEND_FROM_EMAIL=notifications@yourdomain.com
ADMIN_EMAIL_DEV=admin-dev@example.com
ADMIN_EMAIL_PROD=admin@example.com
SEND_WELCOME_EMAIL=false
```

4. Run the development server:
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000)

## Deployment to Railway

1. Push to GitHub
2. Connect repository to Railway
3. Point to `/web` directory in settings
4. Add **ALL** environment variables:

   **Required - Firebase Client-Side:**
   - All `NEXT_PUBLIC_*` variables (client-side Firebase config)

   **Required - Firebase Server-Side (Admin SDK):**
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY`

   **Required - Security:**
   - `SESSION_SECRET` (generate NEW one for production: `openssl rand -base64 32`)

   **Required - Rate Limiting:**
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

   **Optional - Email Notifications:**
   - `RESEND_API_KEY`
   - `RESEND_FROM_EMAIL`
   - `ADMIN_EMAIL_PROD`
   - `SEND_WELCOME_EMAIL`

5. Deploy!

> **Important:**
> - The server-side Admin SDK variables are required for agent OAuth authentication
> - Use a **different** `SESSION_SECRET` for production (not the same as development)
> - Rate limiting will be disabled without Upstash Redis (app still works, but vulnerable to brute force)

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **React:** React 19
- **Language:** TypeScript
- **Styling:** Tailwind CSS 4
- **UI Components:** shadcn/ui (Radix UI)
- **Authentication:** Firebase Auth (Email/Password, Google OAuth, Passkeys/WebAuthn, TOTP 2FA)
- **Database:** Cloud Firestore
- **Session Management:** iron-session (encrypted HTTPOnly cookies)
- **Rate Limiting:** Upstash Redis + @upstash/ratelimit
- **Email:** Resend (optional)
- **AI:** Anthropic SDK + Vercel AI SDK (Cortex features)
- **Deployment:** Railway
