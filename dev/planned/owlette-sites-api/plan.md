# owlette-sites-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

`/api/sites` is read-only today (`GET /api/sites`, `GET /api/sites/{id}`). every site mutation — create, rename, delete, timezone config, member add/remove/role-change — is a direct Firestore write from the dashboard. the CLI stubs all of this. this plan adds the mutation surface.

## scope

two related concerns:

1. **site lifecycle**: create / rename / update-settings / delete (soft, cascade-aware).
2. **site membership**: list members, invite, remove, change role.

## proposed endpoints

### site lifecycle
| method | path | purpose | scope |
|---|---|---|---|
| POST | `/api/sites` | create new site (name, timezone, plan) | user must be paid-tier; site-create quota enforced |
| PATCH | `/api/sites/{id}` | update name, timezone, plan | `site:<id>:admin` |
| DELETE | `/api/sites/{id}` | soft-delete w/ 30d tombstone; cascades: roosts disabled, webhooks paused, machines unassigned | `site:<id>:admin` |

### membership
| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/sites/{id}/members` | list members w/ roles | `site:<id>:read` |
| POST | `/api/sites/{id}/members` | invite by email (sends invite email via resend) | `site:<id>:admin` |
| PATCH | `/api/sites/{id}/members/{uid}` | change role (member/admin) | `site:<id>:admin` |
| DELETE | `/api/sites/{id}/members/{uid}` | remove from site | `site:<id>:admin` |

## auth model

- site-creation is **user-scoped**, not site-scoped — a fresh site has no admin until it's created. uses id-token / session auth, not api-key.
- everything else needs `site:<id>:admin` scope on an api key, or the caller must be a site admin via the user doc's `sites[]`.
- member invite writes to a `pending_invites` collection; accepted on first login with the matching email.

## cli commands unblocked

```
owlette site create --name <n> --timezone <tz>              # returns new siteId
owlette site rename <siteId> --name <n>
owlette site update <siteId> [--timezone --plan]
owlette site delete <siteId> [--yes]                        # soft, 30d recovery window
owlette site members list <siteId>
owlette site members invite <siteId> --email <e> [--role admin|member]
owlette site members remove <siteId> --uid <uid>
owlette site members set-role <siteId> --uid <uid> --role admin|member
```

## non-goals

- cross-site migration of roosts/machines (separate plan).
- paid-tier / billing integration — assumes stripe integration is separate; this plan only checks user has an active plan via the existing user doc.
- sso / saml integration for invite — magic-link emails only.

## estimated size

~10 tasks across 2 waves: (1) site CRUD + cascade logic, (2) membership + invite flow + tests.

## dependencies

- existing installer-download email via resend (pattern reused for invites).
- firestore.rules updates for `sites/{siteId}/members/*` + `pending_invites`.
- superadmin-sweep plan to handle orphan-site detection when creators leave.
