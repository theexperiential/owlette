# Exhaustive E2E Coverage Matrix

This matrix is the source of truth for Playwright coverage. A row is complete
when it has an owner spec and either covered coverage targets or an explicit
deferred reason. "API contract owner" means request-level coverage either in
`api-sprint`, Jest, or the new `api-contracts` specs.

## Routes

| Surface | Roles | Viewports | Owner | Coverage targets | Status |
|---|---|---:|---|---|---|
| `/` landing | public | desktop | `public/static.spec.ts`, `a11y/route-smoke.spec.ts`, `visual/route-smoke.spec.ts` | page smoke, CTA links, serious/critical a11y, nonblank visual smoke | Covered |
| `/demo` | public | desktop | `public/static.spec.ts`, `a11y/route-smoke.spec.ts`, `visual/route-smoke.spec.ts` | mounted demo, list/card controls, visual smoke | Covered |
| `/privacy` | public | desktop | `public/static.spec.ts`, `a11y/route-smoke.spec.ts` | route smoke and legal copy landmark | Covered |
| `/terms` | public | desktop | `public/static.spec.ts`, `a11y/route-smoke.spec.ts` | route smoke and legal copy landmark | Covered |
| `/legal/dmca` | public | desktop | `public/static.spec.ts`, `api-contracts/public-utility.spec.ts`, `a11y/route-smoke.spec.ts` | required fields, success submit, RFC7807 validation shape | Covered |
| `/unsubscribe` | public | desktop | `public/static.spec.ts`, `api-contracts/public-utility.spec.ts` | success/error states and API validation | Covered |
| `/docs/api` | public | desktop | `public/static.spec.ts`, `api-contracts/public-utility.spec.ts` | docs route load and OpenAPI content type | Covered |
| `/download` | public | request | `public/static.spec.ts` | latest-installer redirect and no-installer fallback | Covered |
| `/login`, `/register` | public | desktop | existing `auth/*.spec.ts` | signup/login/logout, MFA redirect behavior | Covered |
| `/setup` | public/auth | desktop | `onboarding/add-cli.spec.ts` | legacy redirect to `/add` with query preservation | Covered |
| `/add` | member/admin | desktop | `onboarding/add-cli.spec.ts` | query prefill, site selection, authorize success/error via stubbed agent API | Covered |
| `/cli/authorize` | member/admin | desktop | `onboarding/add-cli.spec.ts`, `api-contracts/public-utility.spec.ts` | code guard, key options, authorized poll handoff | Covered |
| `/setup-2fa` | member/admin | desktop | `mfa/setup-verify.spec.ts` | QR/manual secret, TOTP verification, backup codes | Covered |
| `/verify-2fa` | enrolled users | desktop | `mfa/setup-verify.spec.ts` | TOTP, backup-code toggle, trust-device option | Covered |
| `/dashboard` | member/admin | desktop, mobile | existing `smoke`, `access-control`, `dispatch`, `time-travel`; `mobile/targeted-shells.spec.ts`; TODO `dashboard/full-controls.spec.ts` | machine card/status/display controls covered; process CRUD, metrics tabs, screenshots, live view, token revocation tracked as dashboard follow-up | Deferred: broad dashboard control sweep needs dedicated full-controls slice to avoid destabilizing existing dispatch specs |
| `/logs` | member/admin | desktop, mobile | `logs/logs.spec.ts`, `mobile/targeted-shells.spec.ts`, `a11y/route-smoke.spec.ts` | action/machine/level/date filters, reset, expand/collapse/all, screenshot modal, clear filtered/all, no-results, pagination seed | Covered |
| `/cortex` | member/admin | desktop, mobile | `cortex/cortex.spec.ts`, `mobile/targeted-shells.spec.ts`, `a11y/route-smoke.spec.ts` | no-key overlay, target selector, offline warnings, power toggle render, send/stop/error stubs, conversation CRUD/search/category | Covered |
| `/admin/presets` | superadmin | desktop, mobile | `access-control/route-guards.spec.ts`, `admin-presets/presets.spec.ts`, `mobile/targeted-shells.spec.ts` | guard, list/category, create/edit/delete, mobile cards | Covered |
| `/admin/users` | superadmin | desktop, mobile | existing `smoke`, `access-control/user-mgmt.spec.ts`, `mobile/targeted-shells.spec.ts` | route guard, users list/actions smoke, mobile shell | Covered |
| `/admin/installers`, `/admin/webhooks`, `/admin/alerts`, `/admin/tokens`, `/admin/schedules`, `/admin/email` | superadmin | desktop | existing `admin/*.spec.ts`, `access-control/route-guards.spec.ts` | CRUD/workflow route coverage | Covered |
| `/roosts` | member/admin | desktop, mobile | existing `roosts/*.spec.ts`, `mobile/targeted-shells.spec.ts`; TODO `roosts/deep-actions.spec.ts` | create/version/rollback/history covered; delete/resync/files/diff/preset/no-target upload tracked | Deferred: remaining roost actions need fixture expansion for version file manifests |
| `/settings/api-keys`, webhooks/settings dialogs | member/admin | desktop | existing `settings/*.spec.ts`, `account/*.spec.ts` | API keys, webhooks, account profile/password/passkeys/preferences | Covered |

## API Routes

| API group | Methods | Owner | Required assertions | Status |
|---|---|---|---|---|
| public utility: `/api/version`, `/api/openapi`, `/api/whoami`, `/api/legal/dmca`, `/api/unsubscribe` | GET/POST | `api-contracts/public-utility.spec.ts` | happy path, validation, unauth problem shape where applicable | Covered |
| CLI device-code | POST | `api-contracts/public-utility.spec.ts`, `onboarding/add-cli.spec.ts` | create, missing-field, pending poll, authorized poll | Covered |
| agent auth/device-code/exchange/refresh | POST | existing API tests plus TODO `api-contracts/agent-auth.spec.ts` | validation, expired, unauthorized, refresh | Deferred: happy path depends on Identity Toolkit exchange and stays stubbed in regular CI |
| sites/members/machines/processes/commands/deployments | mixed | existing `api-sprint/*.spec.ts`, `dispatch/*.spec.ts` | auth, validation, representative domain errors | Covered |
| roosts/chunks/distributions | mixed | existing `roosts/*.spec.ts`, `api-sprint/*`, TODO `api-contracts/roost-actions.spec.ts` | chunk refs, version addressing, rollback/deploy actions | Deferred: R2 remains Firestore-stubbed in CI |
| admin/platform system presets/installers/email/security | mixed | existing `admin/*.spec.ts`, `admin-presets/presets.spec.ts` | superadmin guard, CRUD, validation | Covered |
| account/passkeys/MFA/settings | mixed | existing `account/*.spec.ts`, `mfa/setup-verify.spec.ts` | user auth, validation, mutation persistence | Covered |
| Cortex APIs | POST | `cortex/cortex.spec.ts`, TODO `api-contracts/cortex.spec.ts` | no-key, message validation, categorize, autonomous/escalation stubs | Deferred: real LLM/tool execution is stubbed; request-contract slice remains needed |

## Shared Components And Dialogs

| Component/dialog | Owner | Status |
|---|---|---|
| PageHeader site picker, account menu, download action | existing `access-control/pageheader.spec.ts`, `mobile/targeted-shells.spec.ts` | Covered |
| Account settings tabs: profile, preferences, alerts, Cortex/API key, delete account/photo controls | existing `account/*.spec.ts`; TODO `account/full-dialog.spec.ts` | Deferred: destructive delete/photo controls need isolated fixture users/storage stubs |
| Dashboard machine card/process controls/layout/metrics | existing `access-control`, `dispatch`, `time-travel`; TODO `dashboard/full-controls.spec.ts` | Deferred: major remaining dashboard gap |
| Logs filters/rows/dialogs | `logs/logs.spec.ts` | Covered |
| Cortex sidebar/chat/input/target selector/power toggle | `cortex/cortex.spec.ts` | Covered |
| System preset dialog | `admin-presets/presets.spec.ts` | Covered |
| Deployments uninstall/delete/all dialog options | existing `dispatch/*.spec.ts`; TODO `dispatch/deployment-dialog-options.spec.ts` | Deferred: needs deployment fixture expansion |
| Roost upload/version/delete/resync/files/diff dialogs | existing `roosts/*.spec.ts`; TODO `roosts/deep-actions.spec.ts` | Deferred: needs manifest/file-diff fixtures |

## Cross-Cutting

| Dimension | Owner | Status |
|---|---|---|
| Role gates | existing `access-control/route-guards.spec.ts` plus new `/admin/presets` row | Covered |
| Serious/critical a11y smoke | `a11y/route-smoke.spec.ts` | Covered |
| Visual nonblank smoke | `visual/route-smoke.spec.ts` | Covered |
| Mobile shells where UI differs | `mobile/targeted-shells.spec.ts` | Covered |
| External services | N/A | Deferred: real R2, email delivery, LLM calls, Python agent execution, and passkey authenticators stay opt-in outside regular CI |
