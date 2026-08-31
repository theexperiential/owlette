# CodeQL triage — 2026-08-24

113 open alerts at the time of writing. One cluster was real and is fixed; the
rest are false positives or low-value findings in non-shipped code. This file
records the reasoning so the next person does not re-derive it, and so the
dismissal notes in GitHub can be copied from somewhere reviewable.

**Dismissing requires repo admin in the GitHub security tab — it is not
something a tool should do on the owner's behalf.** Suggested dismissal reason
per rule is given below; "used in tests" and "false positive" are the two
GitHub offers that fit.

---

## Fixed in code

### `js/log-injection` (25) + `js/tainted-format-string` (11) — REAL

`web/lib/logger.ts`, `web/app/api/hoot/autonomous/route.ts`,
`web/lib/hoot/turnRunner.server.ts`.

Machine names, process names, chat ids and nonces arrive from request bodies and
agent registration and land inside `console.*` template literals. A newline lets
the value's author append a fresh, well-formed-looking log line.

Fixed by `web/lib/logSanitize.ts`, applied at the logger sink and at all 24 call
sites across six files.

**These alerts will NOT close, and that prediction was wrong when first written
here.** CodeQL has since analysed both `dev` (73e2d0dc) and `main` (797621f9)
with the fix in place and the per-file counts are unchanged — 12 / 4 / 4 / 2 /
2 / 1. CodeQL does not model `sanitizeForLog` as a sanitiser: its taint
tracking does not carry a barrier across a helper-function boundary, so it
still sees request data reaching `console.*`.

The vulnerability is genuinely remediated — `__tests__/lib/logSanitize.test.ts`
proves newlines, CR, CRLF and C0/C1 cannot survive the helper. What remains is
a tool limitation, so these 36 move from "fixed" to "dismiss with rationale".

> Dismissal note: input is flattened by `sanitizeForLog` before reaching the
> sink (CR/LF escaped, C0/C1 stripped, length capped). CodeQL does not model
> the helper as a barrier. Behaviour is covered by
> `web/__tests__/lib/logSanitize.test.ts`.

Closing them properly instead of dismissing would need a custom CodeQL model
(a data-extension pack declaring `sanitizeForLog` a sanitiser for
`js/log-injection` and `js/tainted-format-string`). Worth doing if this recurs;
not worth it for one helper.

A second correction: the first pass fixed only three files, scoped from the
`tainted-format-string` list. `js/log-injection` spans six — `hoot-escalation`,
`screenshots/finalize` and `alerts/trigger` were missed and are now covered.

---

## Dismiss — false positive

### `js/user-controlled-bypass` (29) — all at `hoot/route.ts:59`

The flagged line is:

```ts
if (!messages || !Array.isArray(messages) || messages.length === 0 || !siteId || !chatId) {
  return NextResponse.json({ error: '...' }, { status: 400 });
}
```

The query reports "user input controls a conditional that guards sensitive
work". That is a description of input validation. The conditional exists
precisely so untrusted input decides whether to *reject* the request; there is
no branch here that grants anything. 29 alerts are one line seen through 29
taint paths.

> Dismissal note: input-validation early-return. The user-controlled condition
> can only cause a 400; no path grants access or skips authorisation.

### `js/insufficient-password-hash` (5)

`web/app/api/keys/route.ts`, `web/app/api/cli/device-code/authorize/route.ts`,
`web/lib/rateLimit.server.ts`, `web/lib/idempotency.ts`,
`web/lib/apiAuth.server.ts`.

The hashed material is not a password. Keys are minted as
`crypto.randomBytes(32).toString('base64url')` — 256 bits of entropy — and
hashed with SHA-256. Slow KDFs (bcrypt, scrypt, argon2) exist to make brute
force expensive against *low-entropy human-chosen* secrets. Brute-forcing a
256-bit random token is infeasible regardless of hash speed, and a slow KDF on
this path would add latency to every authenticated API request for no security
gain.

> Dismissal note: input is a 256-bit `crypto.randomBytes` token, not a
> user-chosen password. Fast hash is correct; a KDF would add per-request
> latency with no benefit against that entropy.

### `js/incomplete-url-substring-sanitization` (3)

`web/lib/webhookSender.server.ts` (`detectPlatform`),
`web/components/WebhookSettingsDialog.tsx` (x2).

All three are `url.includes('hooks.slack.com')` / `'discord.com/api/webhooks'`,
used to choose a payload format and to render a "slack detected" badge. Neither
is a security boundary — a URL that fools the substring check gets a
Slack-shaped payload instead of a generic one, and nothing else.

The actual SSRF guard is `validateWebhookUrl` in `web/lib/webhookUrl.ts`:
https-only (http only under `ALLOW_INSECURE_WEBHOOK_URLS`, which the env
manifest pins to never-set on deploy targets), rejects private, loopback,
link-local and reserved IPv4/IPv6 literals, and caps URL length. It is enforced
on all three webhook write/probe routes.

> Dismissal note: substring match selects a payload format, not an
> authorisation decision. SSRF is enforced separately by `validateWebhookUrl`.

---

## Low — non-shipped code

Not worth a code change; dismiss as "used in tests" where that fits, or leave
open as a known-low backlog.

| rule | count | where | why it is low |
|---|---|---|---|
| `js/incomplete-sanitization` | 4 | `scripts/sync-versions.js`, `scripts/check-lockdown-ready.mjs` | build/ops tooling, run by a maintainer on a trusted checkout; never bundled |
| `js/insecure-temporary-file` | 3 | `scripts/check-lockdown-ready.mjs` | same; local temp files on a dev machine |
| `js/file-system-race` | 2 | incl. `web/e2e/desktop-screenshots/harness.ts:237` | Playwright harness, never shipped; TOCTOU against local files it created |

### `js/polynomial-redos` (2) — dismiss

`cli/src/index.ts:45` is `opts.apiUrl.replace(/\/+$/, '')`. The `\/+$` shape is
the classic polynomial-ReDoS pattern, but the input is the `--api-url` flag the
operator typed on their own command line. Attacker and victim are the same
person, on their own machine.

`sdks/node/src/lib/client.ts:122` reads a response header from the owlette API —
a server the SDK caller chose to talk to. Neither is remote-attacker input.

> Dismissal note: input is an operator-supplied CLI flag / a response header
> from the caller's own configured server. No remote attacker reaches it.

### `js/clear-text-logging` (2) — dismiss, verified

Checked rather than assumed. `scripts/smoke-r2-roundtrip.mjs` passes `apiKey`
into `postJson`, which places it in an `Authorization: Bearer` header and never
logs it. `scripts/provision-r2.mjs` prints bucket names and progress only. No
credential is written to output by either.

> Dismissal note: credential is placed in an Authorization header, not logged.
> Verified by reading both scripts' console output paths.

### `js/file-access-to-http` (7) — dismiss

`cli/src/commands/installer.ts:210` reads the operator-named installer with
`readFileSync(file)` and uploads it; that is precisely what
`owlette installer upload <file>` exists to do. `cli/src/commands/trigger.ts`
reads `--payload-file <path>` and POSTs it — again the documented purpose of
the flag. The remaining five are in `scripts/provision-r2.mjs` and
`e2e-machine/`, provisioning tooling that reads local config and calls the
operator's own Cloudflare/owlette account.

In every case the operator names the file on their own command line and the
destination is their own configured API. The "taint" is the user's intent.

> Dismissal note: file path is an explicit operator argument and the HTTP
> destination is the operator's own configured API. This is the command's
> documented function, not an exfiltration path.

## Still to assess

- `zizmor/ref-version-mismatch` (16, warning) — Actions pinning hygiene, from
  the zizmor workflow rather than CodeQL proper.

## Note on the moving baseline

The open count went 113 -> 118 while this work was in progress, and none of that
was regression from these fixes: the 3.2.0 release (PR #98) landed in between
and brought `js/insufficient-password-hash` +1, `js/file-system-race` +1,
`js/identity-replacement` +1 and `zizmor` +2. Re-read `created_at` before
attributing any count change to a specific commit.

## After the backlog is clear

`main` currently has **no required status checks**, deliberately: `e2e`,
`no-token-logs` and `openapi-validate` are all path-filtered, so requiring one
would deadlock any PR that does not touch those paths, and CodeQL — the only
workflow that always runs — was failing on diff attribution. Once the noise is
dismissed and CodeQL is green on a normal PR, revisit adding it as a required
check.

Note that CodeQL's PR check re-attributes pre-existing alerts when a diff is
large: PR #95 reported "86 new alerts including 50 high severity" while **zero**
alerts had been created that day, and 39 of the 40 flagged files had no
non-comment change. Read `created_at` before believing a "new alerts" number on
a big PR.
