# Accuracy review — synthesis & resolution

Two independent reviews ran against all 13 scripts: `claude-findings.md` and
`codex-findings.md`. This file reconciles them, records what was fixed, and flags two
issues that are **product bugs, not script errors**.

## Disputed claim, resolved in code

The two reviews disagreed on **screenshot / live view permissions** (the grounding pass
said "open to everyone" from menu visibility; the review pass said "admin-gated" from the
command route). Resolved by reading the source directly:

- `web/lib/capabilities.ts:47-50` — members hold only `USER_SELF_PREFS` + `USER_SELF_DELETE`.
- `commands/route.ts:143,181,338` — `capture_screenshot` and `start_live_view` post through
  the `/commands` route, gated on `MACHINE_EXEC_COMMAND` (admin/superadmin only).
- `MachineStatusPill.tsx:68` — offline pill is `bg-red-600` ("offline"), **not grey**.

Verdict: screenshot + live view are **admin-gated**; only **mute alerts** (a per-user pref)
is open to all roles. Scripts corrected accordingly.

## Script fixes applied (all 13 re-validated, parse clean)

- **ep01/03/06** — offline shows a **red** "offline" pill (not grey); usage is a 5-band
  spectrum (green→violet→sky→amber→red).
- **ep02** — pairing phrase appears in a **console window mid-install**, not the final
  screen; browser **prompts** to open (not auto-open); reframed "never sign in on the
  machine" to "authorized from your dashboard / any signed-in browser"; credentials are an
  encrypted machine-locked file; version label made version-neutral.
- **ep03** — nav label is **"deploy"** (not "deployments"); online tile renders "9 / 10".
- **ep04/05** — launch mode is a **segmented control**, not a dropdown; agent GUI shows the
  saved schedule **read-only** (only says "configure via web" when none set).
- **ep06** — temperature bands: 70 to under 85 = warning, **85 and above = critical**.
- **ep07** — screenshot / live view are **admin-gated** like reboot/shutdown; only mute is
  open to everyone (rewrote the permissions beat).
- **ep08** — version-neutral; schedule field read-only nuance.
- **ep09** — **blocked** (see below); added closing-processes status; "percentage" → "progress".
- **ep10** — per-target states include **assembling**; labels queued/synced.
- **ep11** — corrected the **member** role: view assigned sites + own prefs only; commands
  /config are admin powers; role change via the row menu → confirm dialog.
- **ep12** — Cortex reads logs/metrics autonomously and **captures screenshots on demand**
  (not "pulls recent screenshots"); removed the overstated "by anyone" on the kill switch.

## ⚠ Product issues surfaced (for triage — NOT script problems)

1. **Deployment checksum gap (blocks episode 9).** The agent refuses any remote install
   without a sha256 checksum (`agent/src/owlette_service.py:3238-3248`), but
   `web/components/DeploymentDialog.tsx` has **no checksum field** and
   `createDeployment.server.ts` only sends one if provided (`:336,:367`). So a deployment
   created through the **dashboard UI** is rejected by the agent before install. The
   security enforcement landed without a UI path to supply the checksum. Episode 9 can't be
   recorded end-to-end until this is resolved (add a checksum field, or auto-compute on
   upload/finalize).

2. **Member role: UI/copy vs capability mismatch.** `web/app/admin/users/page.tsx:37`
   describes a member as able to "dispatch commands" and "toggle per-machine settings", and
   the machine context menu shows screenshot/live-view to members — but `capabilities.ts`
   grants members neither `MACHINE_EXEC_COMMAND` nor `MACHINE_CONFIG_WRITE`, so those actions
   are rejected server-side. Either the copy + menu visibility should match the capability
   matrix, or the matrix should grant members those abilities. The scripts now describe the
   **actual** (capability-enforced) behavior.
