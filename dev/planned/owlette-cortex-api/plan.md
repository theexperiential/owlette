# owlette-cortex-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

cortex is owlette's ai chat interface. today every `/api/cortex/*` endpoint requires firebase session auth — no api-key support — so the CLI (`owlette cortex *`) ships as stubs. also: no CRUD on conversations themselves exists as a public api; the dashboard does direct Firestore writes to `sites/{siteId}/cortex_chats/*`.

## scope

two concerns:

1. **auth**: add api-key support to every `/api/cortex/*` endpoint. this is the gating blocker for any cli cortex access.
2. **conversation CRUD**: expose the Firestore collection as a public rest api.

## proposed endpoints

### conversation CRUD
| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/sites/{id}/cortex/conversations` | list (cursor-paged, filter by category, search title) | `site:<id>:read` |
| POST | `/api/sites/{id}/cortex/conversations` | create new (title, optional machineId) | `site:<id>:write` |
| GET | `/api/sites/{id}/cortex/conversations/{cid}` | detail + messages | `site:<id>:read` |
| PATCH | `/api/sites/{id}/cortex/conversations/{cid}` | rename, re-categorize | `site:<id>:write` |
| DELETE | `/api/sites/{id}/cortex/conversations/{cid}` | remove | `site:<id>:write` |

### messaging
| method | path | purpose | scope |
|---|---|---|---|
| POST | `/api/sites/{id}/cortex/conversations/{cid}/messages` | send user message; streams assistant reply (SSE) | `site:<id>:write` |
| POST | `/api/sites/{id}/cortex/conversations/{cid}/categorize` | re-run auto-categorization | `site:<id>:write` |

### existing endpoints to audit for api-key support
`/api/cortex`, `/api/cortex/autonomous`, `/api/cortex/escalation`, `/api/cortex/provision-key` — currently session-only. retrofit to accept bearer tokens with the standard `resolveAuth()` helper.

## auth model

- **api-key scope**: `site:<id>:write` for sending messages + mutations, `:read` for listing/viewing.
- **user api-key requirement**: LLM provider key (anthropic/openai) must be configured at the user OR site level before any cortex endpoint succeeds. existing `provision-key` endpoint handles this.
- **tool-call boundary**: cortex can dispatch agent commands (reboot, kill process, etc.). those dispatches must still respect the caller's scopes — an api key without `site:<id>:write` can't have cortex reboot a machine on its behalf.

## cli commands unblocked

```
owlette cortex list --site <s>
owlette cortex new --site <s> [--machine <mid>] --title <t>      # prints conversationId
owlette cortex get <cid> --site <s>
owlette cortex send <cid> <message> --site <s>                    # streams assistant reply
owlette cortex rename <cid> --site <s> --title <t>
owlette cortex delete <cid> --site <s>
owlette cortex categorize <cid> --site <s>
```

## non-goals

- multi-modal input (images, files attached to messages) — follow-up.
- cross-conversation memory / user profiles — model-level feature, not an api concern.
- rate-limiting per-key LLM usage — relies on provider-side limits in v1.
- streaming via websocket — SSE only (matches the rest of roost).

## estimated size

~10 tasks across 3 waves: (1) retrofit existing endpoints for api-key auth, (2) conversation CRUD, (3) messaging + SSE streaming + tests.

## dependencies

- existing `/api/cortex/*` endpoints + MCP tool-call plumbing (already shipped internally).
- `resolveAuth()` helper from wave 2 of roost-public-api — reuse verbatim.
- user-level LLM api key storage (existing feature — verify it accepts api-key-authenticated requests).
