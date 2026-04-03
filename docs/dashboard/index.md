# dashboard

The owlette web dashboard is a Next.js application that provides real-time monitoring and remote control of all your machines. Access it from any browser — desktop, tablet, or mobile.

---

## pages

| Page | URL | Description |
|------|-----|-------------|
| **Landing** | `/` | Marketing page with features overview |
| **Demo** | `/demo` | Interactive dashboard demo (no login required) |
| **Login** | `/login` | Email/password, Google OAuth, or passkey sign-in |
| **Register** | `/register` | Create a new account |
| **2FA Setup** | `/setup-2fa` | Configure TOTP two-factor authentication |
| **2FA Verify** | `/verify-2fa` | TOTP verification step during login |
| **Add Machine** | `/add` | Device code machine pairing target |
| **Dashboard** | `/dashboard` | Main machine and process monitoring view |
| **Cortex** | `/cortex` | AI chat interface for natural language machine management |
| **Deployments** | `/deployments` | Remote software deployment management |
| **Projects** | `/projects` | Project file distribution |
| **Logs** | `/logs` | Activity log viewer with filtering |
| **Admin: Users** | `/admin/users` | User management (admin only) |
| **Admin: Installers** | `/admin/installers` | Agent installer version management (admin only) |
| **Admin: Presets** | `/admin/presets` | System preset management (admin only) |
| **Admin: Schedules** | `/admin/schedules` | Schedule preset management (admin only) |
| **Admin: Tokens** | `/admin/tokens` | Agent token management (admin only) |
| **Admin: Alerts** | `/admin/alerts` | Threshold-based alert rule management (admin only) |
| **Admin: Webhooks** | `/admin/webhooks` | Outbound webhook configuration (admin only) |
| **Admin: Email** | `/admin/email` | Email notification settings (admin only) |

---

## technology

- **Framework**: Next.js 16 with App Router
- **UI**: React 19, TypeScript, Tailwind CSS 4, shadcn/ui (Radix primitives)
- **Charts**: Recharts for metrics visualization
- **Icons**: Lucide React
- **Auth**: Firebase Authentication + iron-session (HTTPOnly cookies)
- **Data**: Firebase Client SDK with real-time `onSnapshot` listeners
- **Hosting**: Railway (auto-deploy from GitHub)
- **AI**: Vercel AI SDK with Anthropic Claude / OpenAI

---

## in this section

- [**Getting Started**](getting-started.md) — First login, site creation, adding machines
- [**Machine Monitoring**](machine-monitoring.md) — Real-time metrics and status
- [**Process Management**](process-management.md) — Add, edit, and control processes
- [**Deployments**](deployments.md) — Remote software installation
- [**Project Distribution**](project-distribution.md) — ZIP file distribution
- [**Cortex**](cortex.md) — AI chat interface + autonomous crash investigation
- [**Activity Logs**](activity-logs.md) — Event monitoring
- [**Admin Panel**](admin/index.md) — User, installer, and token management
