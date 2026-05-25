# Round-2 comprehensive audit brief — Owlette video tutorial plan

You are one of **ten independent reviewers** (5 codex + 5 claude) auditing the SAME thing
in full. There is no division of labor — review **everything**, comprehensively and
individually. Your findings will be cross-compared with the other nine to gauge confidence
and decide whether the plan is viable to commit.

## What "the plan" is — audit ALL of it

The complete video tutorial production plan lives in `dev/video-tutorials/` plus the web
capture harness in `web/`. Review every part:

1. **Production docs** — `dev/video-tutorials/README.md` (pipeline/bible),
   `series-outline.md` (13 episodes), `SCRIPT-FORMAT.md` (the dual-track format + the
   generate.py parser contract).
2. **Scripts** — `dev/video-tutorials/scripts/*.md` (13 episodes). Layperson tutorials;
   each has `**SCREEN:**` direction + `**VOICEOVER:**` spoken text per `## [bNN]` beat.
3. **Voiceover tool** — `dev/video-tutorials/voiceover/generate.py` (+ requirements.txt,
   .env.example, README). Parses scripts → per-beat ElevenLabs MP3s.
4. **Web capture harness** — `web/playwright.videos.config.ts`, `web/e2e/videos/`
   (`video-helpers.ts`, `dashboard-tour.video.ts`, README), and the `videos` /
   `videos:debug` scripts in `web/package.json`. It is meant to REUSE the existing
   screenshots harness (`web/e2e/screenshots/fixtures.ts`, `web/e2e/helpers/`).
5. **Native capture** — `dev/video-tutorials/capture-native/` (`recorder.py`,
   `scenes/install_and_pair.py`, requirements.txt, README). pywinauto-driven.

## Context (so you validate, not re-litigate)

A prior single-pass codex+claude review already ran; fixes were applied and reconciled in
`dev/video-tutorials/review/SYNTHESIS.md` (read it). It also flagged **two product bugs**
(NOT script bugs): (a) dashboard deployments are rejected by the agent because it requires
a sha256 checksum the deploy UI never supplies (`owlette_service.py:3238-3248`), and (b)
the member role's in-app copy/menu advertises abilities `web/lib/capabilities.ts` denies.
**Confirm these are correctly handled in the plan; do not re-report them as new discoveries
unless you find the handling is wrong.** Likewise, validate the prior fixes landed; only
flag a "fixed" item if it is still wrong.

## Audit dimensions (cover all five)

1. **Factual accuracy** — every script claim vs the real app (`web/`, `agent/`). UI labels,
   flows, permissions, where features live. Cite the contradicting `file:line`.
2. **Tooling correctness** — does `generate.py` faithfully implement `SCRIPT-FORMAT.md`
   (beat parsing, voiceover extraction, audio-tag stripping for non-v3, front matter)?
   Is the ElevenLabs REST usage correct? Edge cases/bugs?
3. **Web harness viability** — will `npm run videos` actually work? Does it correctly reuse
   global-setup/emulator/role fixtures? Are `recordScene` (context video + `saveAs`), the
   selectors (`machine-card`, `view-toggle-list`, `cpu` tile), and the fixed-clock/seed
   reuse sound? Will the fake cursor + `narrate` dwell produce usable footage?
4. **Native harness viability** — is the pywinauto approach sound? Is the UAC caveat
   correct? Will `scenes/install_and_pair.py` plausibly drive the Inno Setup wizard, or are
   there gaps that would block recording?
5. **Production viability & completeness** — will this pipeline actually produce the series?
   Gaps that block specific episodes (e.g. ep13 logs needs seeded log entries; ep9 deploy is
   blocked by the checksum bug; episodes needing fixtures that don't exist yet). Outline ↔
   scripts ↔ harness scenario-mapping consistency. Anything missing.

## Method & discipline

- Use ripgrep + targeted line ranges. **Do NOT cat large files** (wastes context/time).
- Severity discipline: **blocker** (must fix before commit — false claim a viewer would act
  on, or broken tooling), **major** (should fix), **minor** (polish). Every finding cites
  `file:line` evidence. **Do not inflate.** A clean result is a valid result — if a part is
  sound, say so. Don't pad with speculative findings.
- Don't edit any plan files. Only write your findings file.

## Required output (write to YOUR assigned findings file)

1. A one-line **VERDICT**, exactly one of:
   - `VIABLE TO COMMIT AS-IS`
   - `VIABLE WITH MINOR REVISIONS`
   - `NEEDS REVISION BEFORE COMMIT`
2. **Blockers** (if any) — each: file + beat/location, the issue, `file:line` evidence, fix.
3. **Majors**, then **Minors** — same structure.
4. **What's sound** — briefly, the parts you verified are correct (so confidence is visible).
