# Round-2 determination — 10-reviewer comprehensive audit

10 independent reviewers (5 codex + 5 claude) audited the entire plan with total overlap.

## Verdict: NOT viable to commit as-is — VIABLE WITH REVISIONS

Vote tally: **0/10 "commit as-is"**, 6 "needs revision" (all 5 codex + claude-1),
4 "viable with minor revisions" (claude 2-5). The split is severity *labeling*; the
substance agrees — there is a concrete punch-list to clear first. The architecture
(decoupled voiceover + Playwright web capture reusing the screenshots harness + pywinauto
native capture) and the factual accuracy of the vast majority of script claims were
affirmed by all ten.

Confidence = number of independent reviewers (of 10) who flagged it. Two disputes were
adjudicated by reading the code directly (not by vote).

## MUST FIX before commit

| # | Issue | Confidence | Notes |
|---|---|---|---|
| 1 | **Native scene `install_and_pair.py` contradicts corrected ep02 AND blocks on the pairing console.** Comments say phrase is on the finish page + browser auto-opens; real flow prints the phrase in a `configure_site.py` console mid-install (`owlette_installer.iss:261-275`) and prompts `[y/N]` (`configure_site.py:358`). The wizard blocks at `ssPostInstall` on that console, so driving to "Finish" stalls. | **10/10** | Rework: page the wizard up to where the pairing console appears, then hand off to OBS/manual for the console + browser (b05-b09); fix comments/print. |
| 2 | **ep12 b05 Cortex confirmation gate is a FALSE SAFETY CLAIM.** Script says Cortex "stops and asks you to confirm" before reboot/shell and "you always get the final yes." VERIFIED IN CODE: `cortexStream.server.ts:405-406` passes all tier-≤max tools (tier-3 included for admins) to `buildExecutableTools`, which attaches an auto-running `execute` to every one (`cortex-utils.server.ts:1079`). `requiresConfirmation` (`mcp-tools.ts:1181`) is **dead code** — never called; `ToolCallCard` only shows a tier *label*. No gate exists. | **adjudicated** (2 codex correct; 5 claude wrong) | Rewrite b05 to describe real guardrails (per-machine on/off toggle + member tier-1 cap), drop the confirmation claim. **Also a product/security gap** — see below. |
| 3 | **ep07 b07 + ep11 b03: "remove machine" / "revoke token" are SUPERADMIN-only, not site-admin.** `SITE_ADMIN_CAPABILITIES` lacks `MACHINE_REMOVE` (`capabilities.ts:52-63`); `removeMachine.server.ts:15` "superadmin only"; revoke-token needs `GLOBAL_SETTINGS_WRITE` (superadmin). Tests confirm (`capabilities.test.ts:112`). | **4/10** + tests | Move both actions to the superadmin tier in both beats. (Screenshot/live view/reboot/shutdown ARE correctly admin.) |
| 4 | **ep13 b06 clear-logs is a DATA-LOSS footgun.** Script teaches date-range + full-text search filters (b03), then says clear "wipes entries matching your current filters." VERIFIED: clear only honors action/machine/level (`clearLogs.server.ts:32-39,86-88`); `handleClearLogs` ignores date/search when computing `hasFilters` (`logs/page.tsx:665-668`) → date/search-only filter sends `{all:true}` and deletes ALL logs. | **adjudicated** (1/10, real) | Rewrite b06: clear scopes only by action/machine/level — NOT date or search. |
| 5 | **`generate.py --only-beat` corrupts `manifest.json`.** Skips non-selected spoken beats before the manifest append (`generate.py:300-306`) then overwrites the manifest (`:323`), leaving a partial manifest after the documented "re-render one beat" workflow. | **6/10** | Merge into the existing manifest in `--only-beat` mode (or skip the rewrite). |
| 6 | **`generate.py` model precedence mismatch (latent).** Tag-strip uses front-matter-first (`:189`); synthesis uses env/CLI-first (`:269` + `:363-365`). With default `.env` (`ELEVENLABS_MODEL_ID=eleven_multilingual_v2`) + a script's `model: eleven_v3`, tags are KEPT but synthesized on v2 → v2 reads "[warm]" aloud — the exact failure the design promises to prevent. Dormant today (all scripts `model: null`). | **4/10** | Resolve one effective model (CLI → front-matter → env → default) and use it for both strip + synthesis. |

## SHOULD FIX (honesty / coverage)

| # | Issue | Confidence | Notes |
|---|---|---|---|
| 7 | **Web harness over-claims coverage.** README presents `npm run videos` as "all scenes" + maps 11 episodes, but only `dashboard-tour.video.ts` exists, and it stops at b04 (ep3 script has b05-b06). ep8 native scene is also listed "to add." | ~5/10 | Mark the harness explicitly as a 1-scene **example/scaffold**; complete the ep3 example to all beats; state remaining scenes are to be built. |
| 8 | **`series-outline.md` sketches are stale vs corrected scripts.** ep2 "browser auto-opens" (5/10), ep11 "add a user" (no invite flow), ep9 "verify path" option (not in dialog), ep4 "cooldown" field (not in dialog). | mixed | Update the sketches; the authoritative scripts are already correct. |
| 9 | **Per-episode capture-method gaps** (narration is fine; the assigned scenario can't show it): ep06 b07 offline machine only exists in `dashboard-mixed-states` (not `monitor-single-machine`); ep06 b06 machine-switcher needs >5 machines (scenario seeds 4); ep11 b04 alerts list needs a `settings/alerts` seed + superadmin role (`automate-schedule-editor` seeds a different schema); ep12 b04/b05 live chat can't be driven (no LLM stub → must scroll the seeded conversation); ep13 needs a log-seed fixture (already flagged in-script). | 1-3 each | Add per-beat capture notes / adjust scenario or seed; ep9 + ep13 gaps already flagged in-script. |

## MINOR / polish
- `recorder.py smooth_move` is a no-op glide — `mouse.get_cursor_pos` doesn't exist; use `win32api.GetCursorPos()` for the start point (4/10).
- `videos:debug` README says "inspector" but the script only passes `--headed` — add `--debug` or fix wording (3/10).
- ep03 b01 breadcrumb "main gallery" vs seeded site name "flagship" (SCREEN direction only) (3/10).
- ep01/ep03 usage-color shorthand (3-band) vs the real 5-band spectrum — acceptable layperson simplification, optional (2/10).
- ep12 b04 "checkLogs" example tool isn't a real tool name (real: `get_site_logs`) (1/10).
- ep9 b06 "per-target cancel button" — cancel is actually deployment-wide (`useDeployments` discards machineId) (1/10); ep9 is blocked anyway.

## NEW product issues surfaced (your triage — beyond the 2 known)
1. **Cortex tier-3 confirmation gate is unimplemented.** `requiresConfirmation` is dead code; the execution path auto-runs tier-3 (reboot/shell/deploy) for admins. The in-app docs (`web/content/docs/dashboard/cortex.mdx`) also claim the gate. Safety/security gap — decide whether to build the gate or update product+docs to state there isn't one.
2. **clear-logs ignores date/search filters** (see #4) — a UI that deletes more than the visible/filtered view is a data-loss risk independent of the tutorial.
(Plus the known #2 from round 1: admin UI/copy advertises remove-machine that capabilities deny — now extended to ep07/ep11, item #3.)

## Already-correct (verified, do not re-touch)
ep09 checksum block (correctly NOTE'd), member-role copy (capability-accurate), the
voiceover parser/ElevenLabs REST usage, the web harness infra wiring (npm script mirrors
`screenshots`, fixtures/selectors/role reuse all resolve), the pywinauto/UAC approach,
and the bulk of factual claims (colors, temps, schedules, roost states, deploy labels,
logs badges, tray/GUI). See the 10 per-reviewer files for the full verified list.

---

## Revisions applied (post-determination)

All MUST + SHOULD + MINOR items above were applied and revalidated (py_compile clean;
all 13 scripts parse, 25,279 chars; package.json valid; eslint + tsc clean on the video
TS; no NOTE/code text leaks into any spoken line):

- **#1** native `install_and_pair.py` reworked — drives wizard pages only, stops at the
  pairing console (which blocks the wizard) and hands b05–b09 to OBS; comments/print fixed.
- **#2** ep12 b05 rewritten — no confirmation-gate claim; describes the real controls
  (admin tier + per-machine switch). b04/b05 capture switched to scrolling the seeded
  conversation. `**NOTE:**` documents the unimplemented gate as a product gap.
- **#3** ep07 b07 + ep11 b03 — "remove machine" / "revoke token" moved to superadmin.
- **#4** ep13 b06 — clear-logs scoped to action/machine/level only, with an explicit
  warning that date/search filters do NOT limit the delete.
- **#5/#6** `generate.py` — single model precedence (CLI→front-matter→env→default) used
  for both tag-stripping and synthesis; manifest now written for ALL beats so `--only-beat`
  no longer truncates it. Verified: v2 strips tags, v3 keeps them.
- **#7** web harness READMEs marked as a one-scene example (ep3 b01–b04); `--grep` fixed;
  `videos:debug` now passes `--debug`; scene docstring updated.
- **#8** series-outline stale sketches fixed (auto-open, add-user, verify-path, cooldown,
  tray icon).
- **#9** per-episode capture NOTEs added (ep06 b06 >5-machines, ep06 b07 offline machine,
  ep11 b04 settings/alerts seed + superadmin).
- **MINOR** `recorder.py smooth_move` now reads the real cursor start (Win32 GetCursorPos);
  ep12 "checkLogs" → generic tool-call card; ep9 per-target cancel → deployment-wide cancel;
  ep03 breadcrumb "main gallery" → "flagship".

## Still open — PRODUCT decisions (NOT script issues; scripts now describe actual behavior)
1. **Cortex tier-3 confirmation gate is unimplemented** (`requiresConfirmation` dead code;
   docs at `web/content/docs/dashboard/cortex.mdx` claim it). Build the gate or correct
   product + docs.
2. **clear-logs ignores date/search filters** — deletes more than the filtered view.
3. **Admin UI/copy advertises remove-machine** that `capabilities.ts` denies
   (`admin/users/page.tsx`, `MachineContextMenu` shows it to site admins).

These three are the only things standing between the plan and a clean commit.
