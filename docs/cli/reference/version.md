---
hide:
  - navigation
---

# version

`version` prints the cli's own package version alongside the server's current dated api-version and the full list of `Roost-Version` values the server accepts today. acts on the cli's own state — no site / machine targeting, no auth required (the endpoint is unauthenticated; the cli forwards a token if one is configured but does not require it). tier: `[ready]`.

use this to:

- confirm the cli + server are on compatible api versions before running a long script
- discover which `Roost-Version` dates the server still accepts (older ones drop off the list when retired)
- pin a specific `Roost-Version` for a one-off probe with `--api-version`

---

## version

```bash
owlette version [--api-version <YYYY-MM-DD>] [--json]
```

| flag | type | required | description |
|---|---|---|---|
| `--api-version <YYYY-MM-DD>` | string (date) | no | pin the `Roost-Version` request header on this single request. the `/api/version` endpoint accepts any value (it's the catalog clients probe before they know what's supported), but if the pinned date is older than the server's minimum a warning is emitted to stderr |
| `--json` | boolean (global) | no | emit the structured record instead of the one-line human form |

### examples

```bash
# default — one-line summary
owlette version
# cli 1.4.0  |  server 2026-04-15  |  supported versions: 2026-01-10, 2026-02-28, 2026-04-15
```

```bash
# json envelope — script-friendly
owlette version --json
# {
#   "cli": "1.4.0",
#   "server": "2026-04-15",
#   "supportedVersions": ["2026-01-10", "2026-02-28", "2026-04-15"],
#   "minimumVersion": "2026-01-10",
#   "pinned": null
# }
```

```bash
# pin an older Roost-Version — emits a stderr warning if it's below the server minimum
owlette version --api-version 2025-11-01
# owlette: warning — pinned api-version 2025-11-01 is older than server minimum 2026-01-10; some endpoints may reject your requests
# cli 1.4.0  |  server 2026-04-15  |  supported versions: 2026-01-10, 2026-02-28, 2026-04-15
```

backing: `GET /api/version`. unauthenticated — token is forwarded as `Authorization: Bearer <token>` if one is configured, but the endpoint does not require it.

---

## output

### human mode

a single line on stdout:

```
cli <X.Y.Z>  |  server <YYYY-MM-DD>  |  supported versions: <D1>, <D2>, ...
```

if `--api-version` pins a date older than the oldest entry in `supportedVersions`, a warning line is written to stderr **before** the summary line is written to stdout.

### json mode (`--json`)

```json
{
  "cli": "1.4.0",
  "server": "2026-04-15",
  "supportedVersions": ["2026-01-10", "2026-02-28", "2026-04-15"],
  "minimumVersion": "2026-01-10",
  "pinned": null
}
```

| field | type | meaning |
|---|---|---|
| `cli` | string | the cli's own `package.json` version (resolved by walking up from the binary to the nearest `@owlette/cli` package), or `"unknown"` if it can't be located |
| `server` | string | the server's current dated api-version (`current` from the response) |
| `supportedVersions` | string[] | every `Roost-Version` date the server currently accepts, in the order returned by the api |
| `minimumVersion` | string | lex-min of `supportedVersions` (lex order on `YYYY-MM-DD` is chronological), or `server` if the list is empty |
| `pinned` | string \| null | the `--api-version` value, trimmed; `null` if the flag was not passed |

> note: `version` predates the `{ ok, data }` wrapper. its json envelope is the raw shape above for compatibility with scripts written against earlier cli versions — see [overview](../overview.md#json-envelope-schema).

---

## exit codes

- `0` — success (warning to stderr does not change the exit code)
- `1` — network failure, non-2xx response from `GET /api/version`, or unexpected response shape (missing `current` or empty `supported`)

---

## notes

- **scope**: user (acts on the cli's own state — no site / machine targeting)
- **tier**: `[ready]`
- **auth**: not required. the `/api/version` endpoint is public. if a token is configured for the active profile the cli forwards it, but a missing / invalid token does not cause the command to fail
- **`Roost-Version` header**: dated `YYYY-MM-DD` strings, not semver. lex order on these strings == chronological order, which is how the cli computes `minimumVersion` from `supportedVersions`
- **related**: [overview](../overview.md) for the cli's full version-pinning + config story
