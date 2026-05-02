# self-hosting

owlette is available as a hosted service at [owlette.app](https://owlette.app) - no setup required. If you run your own instance, this section covers the Firebase, storage, web runtime, and agent pieces you need to operate the full stack.

---

## why self-host?

- **Data sovereignty** - Keep app data in your own Firebase project and object storage in your own Cloudflare R2 bucket
- **Custom domain** - Run the dashboard on your own URL
- **Full control** - Modify the codebase, add features, integrate with your infrastructure
- **Development** - Contribute to owlette or build on top of it

---

## what you'll need

| requirement | purpose |
|-------------|---------|
| **Firebase project** | Authentication, Firestore, Admin SDK credentials, and Firebase Storage for installer/screenshot flows |
| **Cloudflare R2 bucket** | Object storage for roost chunk uploads, signed URLs, and version assembly |
| **Railway account** (or any Node.js 20 host) | Web dashboard hosting for the Next.js app |
| **Node.js 20+** | Local development, web builds, and Firebase Functions compatibility |
| **GitHub repository** | Source code and CI/CD |
| **Upstash Redis** | API rate limiting |
| **Email provider** | Alert and welcome email delivery |
| **Cron scheduler** | Machine offline detection and optional public status-page pings |
| **Windows 10+ machine** | Agent installation target |

---

## setup sequence

1. [Firebase Setup](firebase.md) - create the Firebase project, enable Authentication, Firestore, and Firebase Storage, then generate service-account credentials.
2. [Environment Variables](environment-variables.md) - collect Firebase client/admin values, session secrets, Upstash Redis, email, cron, and Cloudflare R2 credentials before deployment.
3. [Firestore Rules](firestore-rules.md) - deploy the repository's Firestore rules and indexes so users and agents can access only their scoped data.
4. [Web Deployment](web-deployment.md) - deploy the Next.js dashboard to Railway or another Node.js 20 host and attach the required environment variables.
5. First admin account - register through the deployed dashboard, then promote the initial operator in Firestore.
6. [Agent Installation](../agent/installation.md) - install the Windows agent on target machines and pair it with your self-hosted dashboard.

---

## storage responsibilities

Firebase and R2 serve different parts of the self-hosted system:

| storage service | used for |
|-----------------|----------|
| **Firestore** | Sites, users, machines, commands, settings, audit/activity data, and agent state |
| **Firebase Storage** | Installer binaries and screenshot-backed workflows |
| **Cloudflare R2** | roost content chunks, signed upload/download URLs, immutable versions, and rollback assembly |

For the complete variable inventory, use [Environment Variables](environment-variables.md). For deploy-time runtime requirements and host configuration, use [Web Deployment](web-deployment.md).
