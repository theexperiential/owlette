# roost api — overview

roost is the content-addressed deployment platform for fleets of long-running windows machines — digital signage, kiosks, touchdesigner installs, media servers, point-of-sale rigs. operators publish a new version of a project once and every targeted machine atomically adopts it, with one-click rollback if something breaks. the api automates that loop from ci/cd, scripts, render farms, or slack bots.

---

## mental model

roost is four concepts stacked in a deliberate order. learn them in this order and the rest of the api falls out naturally.

**1. chunks — content-addressed blobs.**
every file you publish is split into 4 mib pieces and each piece is stored under its sha-256 digest. identical bytes are stored once per tenant regardless of how many files or versions reference them. you never name a chunk — you upload it by hash and fetch it by hash. this is the data plane.

**2. versions — immutable snapshots.**
a version is an oci-shaped document listing every file in a deployment and the chunk digests that make it up. once published, a version is never mutated; a new publish produces a new version with its own id and a monotonically increasing `versionNumber`. versions are what you actually compare, diff, and roll back between.

**3. roosts — named, versioned bundles.**
a roost is the deployment unit: a stable id (like `roost_lobby_td`) that points at a *current* version and remembers its history. publishing is a pointer move — the bytes are already in r2 as chunks; the version references them; the roost's pointer flips atomically from the old version to the new one. rollback is the same flip in reverse. roosts have a target list (which machines should run them) and belong to a site.

**4. deployments — targeted fan-out to machines.**
when a roost's current version changes, agents on target machines diff what they have against the new version, pull only the missing chunks, verify each hash, and overwrite the listed files in place. agent apply is patch-mode: files listed in the version get written; files outside the version stay where they are (see [versions.md §10](./versions.md#10-how-agents-apply-a-version-patch-semantics) for the full semantics, including how rollback interacts with files that have been removed from a version). a deployment is the record of this rollout: machines, roles (canary vs fleet), per-machine state, bytes transferred. you can also trigger one explicitly with scheduling, dry-run, and canary strategy.

the flow, end to end: chunk your files → upload the missing chunks → publish a version pointing at them → the roost's pointer flips → agents fan out and apply → rollback is one api call away.

---

## api vs dashboard

both front the same data. pick the one that fits the task.

**use the api when:**
- ci/cd is publishing a roost on every git tag or render-farm job completion
- you're running a nightly sync from a network share into one or more roosts
- a slack `/rollback` command needs to trigger a revert without a human opening a browser
- you're provisioning roosts in bulk from a spreadsheet or infra-as-code config
- you want machine-readable state for dashboards, alerting, or compliance exports

**use the dashboard when:**
- you're exploring: "which version is currently on machine-a7f3, and when did it last sync?"
- you're doing one-off admin: renaming a roost, editing a target list, revoking a key
- you're watching a rollout progress live and want the canary → fleet visualization
- you're onboarding a new teammate and want them to *see* the system before scripting it

api and dashboard are symmetric — anything you can do in one, you can do in the other (with the exception of site create/delete, which is dashboard-only in v2). they are not alternatives so much as different surfaces on the same platform.

---

## pricing tiers

plans are per-site. storage is deduplicated chunk bytes in r2; bandwidth is egress to agents. exact limits and overage pricing are on the pricing page — the snapshot below is the shape of the tiers.

| tier | monthly | storage | best for |
|---|---|---|---|
| free | $0 | 5 gb | evaluating roost, one-machine personal setups |
| starter | $8 | 25 gb | a single small fleet (5–15 machines), one project |
| pro | $15 | 100 gb | multi-fleet operators, bigger touchdesigner projects |
| enterprise | $25–40 | bring-your-own r2 bucket | large fleets, data-residency needs, custom quotas |

rate limits scale with tier; every response carries `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers so you can pace without guessing. see [rate limits](./rate-limits.md) for the backoff protocol and retry guidance.

---

## next steps

- **[quickstart](./quickstart.md)** — curl walkthrough: create a key, push a roost, verify, roll back. ~10 minutes.
- **[authentication](./authentication.md)** — `owk_live_*` / `owk_test_*` keys, scoping, rotation, revocation, `Authorization: Bearer` header.
- **[errors](./errors.md)** — rfc 7807 problem+json envelope, stable error codes, `doc_url` resolution.

from there, deep-dive into the [chunks](./chunks.md), [versions](./versions.md), and [webhooks](./webhooks.md) guides as you need them. the full endpoint reference lives in [openapi.yaml](../../web/openapi.yaml) and is machine-readable.
