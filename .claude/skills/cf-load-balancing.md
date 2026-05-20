# Cloudflare Load Balancing (owlette.app failover) Guidelines

**Applies To**: The `owlette.app` failover load balancer — Railway primary, Vercel standby

---

## What this is

`owlette.app` runs behind a Cloudflare load balancer that fails over between two
origins on different clouds, so a provider-level outage (e.g. Railway losing GCP
egress) doesn't take the app down:

- **Railway** (`owlette-prod` service) — primary
- **Vercel** (`owlette` project) — standby, kept fresh via git-connect

Managed as Terraform (IaC) in `infra/cloudflare/`. Companion systems:
[[env-management]] (env var parity across both origins) and the `/api/health`
readiness probe both origins are checked against.

---

## Topology (infra/cloudflare/main.tf)

1. **monitor** — `GET /api/health` every 60s, expects `200`, sends `Host: owlette.app`.
   `/api/health` returns 200 only when the origin can reach Firestore, so an origin
   that's up but cut off from its backend is correctly marked unhealthy.
2. **two pools** — `owlette-railway-primary`, `owlette-vercel-standby`; each rewrites
   the Host header to `owlette.app` so the origin routes + serves TLS correctly.
3. **load balancer** on `owlette.app` — `steering_policy = "off"` = cascade: send all
   traffic to the first healthy pool in `default_pool_ids` (Railway), fall back to
   Vercel only when Railway's monitor fails.

---

## Apply workflow

```bash
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # fill in real values (gitignored)
export CLOUDFLARE_API_TOKEN=...                # scoped token, NEVER in a file
terraform init       # first time / after provider bumps
terraform plan       # review the diff
terraform apply      # creates monitor + pools + LB
```

`terraform` is on PATH via winget; if a shell has stale PATH, prepend
`/c/Users/<user>/AppData/Local/Microsoft/WinGet/Links`.

### Required inputs (terraform.tfvars)

- `account_id`, `zone_id` — Cloudflare dashboard → owlette.app → **Overview** →
  right sidebar **API** box. Or, once `CLOUDFLARE_API_TOKEN` is set, via API:
  `GET https://api.cloudflare.com/client/v4/zones?name=owlette.app` returns both
  the zone `id` and `account.id`.
- `railway_origin` — **NOT** `RAILWAY_PUBLIC_DOMAIN` (that's `owlette.app` itself —
  pointing the pool at it is circular). Use the hostname `owlette.app` currently
  CNAMEs to in Cloudflare DNS (the target Railway issued for the custom domain).
  Find it: Cloudflare DNS record for owlette.app, or Railway → owlette-prod →
  Settings → Networking. Hostname only, no scheme.
- `vercel_origin` — the Vercel project's production alias, `owlette-eight.vercel.app`
  (`vercel` deploy "Aliased" line / dashboard). Hostname only, no scheme.

### Token scope

`CLOUDFLARE_API_TOKEN` must have: **Account › Load Balancing: Monitors and Pools › Edit**
and **Zone › Load Balancers › Edit** (for the owlette.app zone). Pass via env var only.

---

## Critical Rules

### Do
- **Enable the Load Balancing add-on** on the Cloudflare account first — the API
  rejects LB creation without it (a billing toggle, dashboard-only).
- **Add owlette.app as a domain on the Vercel project** so the standby accepts the
  rewritten `Host: owlette.app` (verifiable without moving DNS). Railway already has it.
- **Keep state safe.** Local `*.tfstate` is gitignored. For shared/durable state,
  move to the R2-backed S3 backend stubbed in `versions.tf`.
- **Commit `.terraform.lock.hcl`** (pins provider versions); it's intentionally not ignored.

### Don't
- **Never put `CLOUDFLARE_API_TOKEN` or real `terraform.tfvars` in git.**
- **Don't point `railway_origin` at `owlette.app`** — it must be the underlying Railway
  origin, or the LB loops back on itself.
- **Don't bump the cloudflare provider to v5** without migrating — the module targets
  the v4 schema (`default_pool_ids`/`fallback_pool_id`, `header {}` blocks). v5 renamed
  these. The `~> 4.52` pin in `versions.tf` is deliberate.
- **Don't change `steering_policy`** from `"off"` unless you intend to stop pure
  failover — `"off"` is what makes it cascade by pool order.

---

## Prereqs

- Terraform >= 1.5 (`winget install Hashicorp.Terraform`).
- Load Balancing add-on enabled on the Cloudflare account.
- owlette.app DNS already on Cloudflare (it is).
