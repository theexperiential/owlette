# owlette-users-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

no public `/api/users/*` endpoints exist. superadmins manage users (list, change role, assign sites, delete) via direct Firestore writes from the dashboard's superadmin pages. the CLI's `owlette user *` is entirely stubbed. this plan adds the platform-wide user-management api.

## scope

list / detail / role-change / site-assignment / delete — all superadmin-only. no self-service user creation (users sign up via firebase auth as today).

## proposed endpoints

| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/users` | list all platform users (superadmin only) | platform:superadmin |
| GET | `/api/users/{uid}` | user detail (role, sites, last login, api-key count) | platform:superadmin |
| PATCH | `/api/users/{uid}/role` | promote/demote (member → admin → superadmin) | platform:superadmin |
| PATCH | `/api/users/{uid}/sites` | replace entire sites[] array | platform:superadmin |
| POST | `/api/users/{uid}/sites/{siteId}` | add single site access | platform:superadmin |
| DELETE | `/api/users/{uid}/sites/{siteId}` | revoke single site access | platform:superadmin |
| DELETE | `/api/users/{uid}` | delete user (cascades: api-keys revoked, sessions killed) | platform:superadmin |

## auth model

- new scope tier: `platform:superadmin`. api keys minted by a superadmin can carry this scope; otherwise rejected.
- the existing `user.role === 'superadmin'` check (via `isSuperadmin()` in auth context) maps 1:1 to this new scope.
- destructive ops (delete, role-demote of last superadmin) require a **confirmation token** in the body — a short-lived token minted by a separate `POST /api/users/{uid}/confirmation-token` endpoint. prevents accidental automation.

## cli commands unblocked

```
owlette user list [--role --search]
owlette user get <uid>
owlette user promote <uid> --role admin|superadmin
owlette user demote <uid>
owlette user sites list <uid>
owlette user sites add <uid> --site <siteId>
owlette user sites remove <uid> --site <siteId>
owlette user sites set <uid> --sites <csv>              # full replace
owlette user delete <uid> --confirmation-token <token>
```

## non-goals

- user self-service role change (always requires superadmin).
- bulk user import / csv upload — follow-up plan if ops asks for it.
- SSO / saml role mapping — separate identity-provider plan.
- firebase-auth user creation (sign-up flow) — stays as-is.

## estimated size

~8 tasks across 2 waves: (1) list/get/role-change + scope tier, (2) sites-assignment + delete w/ confirmation + tests.

## dependencies

- `platform:superadmin` scope tier needs adding to `apiKeyTypes.ts` (small breaking change to the scope grammar — currently only has `site`/`roost`/`machine` resources).
- key-creation UI must gate superadmin-scope minting behind the current user's role check.
