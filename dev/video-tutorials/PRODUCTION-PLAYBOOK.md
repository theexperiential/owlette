# product video tutorial production playbook

A portable, product-agnostic playbook for producing (and *maintaining*) a narrated
tutorial series with automated capture and synthesized voiceover. Owlette's series
(`dev/video-tutorials/`) is the worked example throughout, but every section states
the general principle first so the workflow transfers to any product.

This is the companion to `README.md` (the owlette-specific production bible). Read
that for the exact owlette commands; read this to replicate the system elsewhere.

---

## 1. The core architecture: script as single source of truth

Everything downstream — voice, screen footage, and assembly — derives from one
markdown script per episode. Voice and picture are produced **independently** from
that script and only meet in the edit. This is the load-bearing decision; the rest
of the pipeline falls out of it.

```
                       scripts/NN-slug.md
                (dual-track: SCREEN + VOICEOVER,
                 split into ## [bNN] beats)
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
  TTS VOICEOVER         WEB CAPTURE            NATIVE CAPTURE
  one MP3 per beat      browser automation     desktop automation
  (ElevenLabs)          (Playwright, seeded    (pywinauto / OBS
                        demo data, 1080p)      over the real app)
        │                     │                      │
        └──────────┬──────────┴───────────┬──────────┘
                   ▼                      ▼
              ASSEMBLY in an NLE (DaVinci Resolve, free):
              per-beat MP3 dropped under its matching footage,
              screen trimmed to voice length, zooms/callouts added
```

**Why decoupled voice/picture wins:**

- **Change-isolation.** When product copy changes, you re-render *one beat's MP3*
  (cents) and re-capture *one scene* (minutes) — never a whole take. This is what
  makes a tutorial series *maintainable* against a product that ships weekly.
- **No performance skill needed.** Nobody reads on camera; nobody narrates while
  clicking. The TTS voice never has an off day, and screen actions are driven by
  automation, so both tracks are individually repeatable.
- **Beat-level sync is drag-and-drop.** `epNN-bNN.mp3` names line up 1:1 with the
  beats in the script and the sections of the capture, so the edit is mechanical.

**The beat is the atomic unit.** One beat = one chunk of narration + the screen
action it plays over ≈ one MP3 ≈ one editable sync point. Keep narration ≤ ~25
seconds per beat; split anything longer.

---

## 2. The script format (dual-track markdown)

Full spec: `SCRIPT-FORMAT.md`. The essentials, portable to any project:

- One markdown file per episode: `NN-slug.md`, YAML front matter carrying
  `number / slug / title / est_duration / capture (web|native|mixed) / scenario`
  plus optional per-episode TTS voice/model overrides.
- Each beat:

  ```markdown
  ## [b03] short human title
  **SCREEN:** what's on screen, the action performed, zoom/callout notes.
  **VOICEOVER:**
  the spoken words. the ONLY text ever sent to TTS.
  ```

- Direction labels (`**SCREEN:**`, `**B-ROLL:**`, `**ON-SCREEN:**`, `**NOTE:**`)
  always precede `**VOICEOVER:**` and are always stripped from narration.
- The format doc doubles as the **parser contract** for the TTS generator — change
  one, change both.
- House voice style: written for the ear (spell out how things should *sound*),
  punctuation as pacing, one idea per beat, and match the product's UI voice
  (owlette: lowercase, conversational).

**Why markdown, not a spreadsheet or NLE markers:** it diffs, it reviews like code
(agents and humans can fact-check it against the codebase), it's versioned next to
the product it documents, and one file feeds every downstream tool.

---

## 3. Voiceover: per-beat TTS

Owlette implementation: `voiceover/generate.py` (ElevenLabs REST, no SDK).

- Parses the dual-track script, extracts each beat's narration, renders
  `out/NN-slug/epNN-bNN.mp3` + a `manifest.json` (per-beat text hash, characters,
  cost) per episode.
- `--dry-run` prints beats, character counts, and estimated credit cost with zero
  API calls — **always dry-run before spending credits.**
- Model settings are *locked by A/B test, then recorded*: owlette uses
  `eleven_v3`, `--stability 0.3`, the user's own professional voice clone
  (PVC `Dylan Roscover`, requires ElevenLabs Creator tier+). Bracketed `[audio
  tags]` are v3 performance direction and are auto-stripped on non-v3 models, so
  scripts stay model-portable.
- Cost calibration from the owlette run: all 13 episodes ≈ 87 beat MP3s ≈ 27.4k
  credits ≈ $5. Voiceover cost is *not* a constraint; treat re-renders as free-ish
  but never re-render beats whose text didn't change (the per-beat manifest makes
  the diff trivial).
- Rendered audio is **gitignored** (binary, regenerable) — keep local backups; the
  script + manifest are the durable record.

**Porting to another project:** the generator is product-agnostic already — it
needs only the script format, an API key, and a voice id. Copy
`voiceover/` wholesale, change `.env`.

---

## 4. Screen capture: automate everything automatable

### 4a. Web surfaces → Playwright against seeded demo data

Owlette implementation: `web/e2e/videos/` + `web/playwright.videos.config.ts`
(`npm run videos`, one `NN-slug.video.ts` scene per browser episode).

The non-obvious part is **not** the recording — it's making the product *look
demo-worthy and identical on every run*:

- **A seeded demo fleet, not test fixtures.** The capture harness reuses the
  screenshot harness's seeded scenario data (10 machines with realistic names —
  `media-server-stage`, `td-control-room` — realistic metrics, mixed states)
  against the local emulator. Real-looking data is what separates a tutorial from
  a test artifact.
- **Determinism guards:** fixed clock (relative timestamps never drift between
  takes), seeded PRNG for sparkline/metric noise, CSS animations disabled so the
  only motion is intentional.
- **Human pacing injected deliberately** (`video-helpers.ts`): a rendered fake
  cursor that *moves* to targets, typewriter-paced typing, `narrate()` dwell times
  sized to the beat's narration, highlight pulses for callouts. Raw Playwright is
  robotically fast; tutorials need watchable pacing.
- **Recording:** 1080p per-scene recording; owlette adds an ffmpeg
  ddagrab/NVENC recorder (`ffmpeg-recorder.ts`) with a probe gate + ffprobe
  validation for high-quality capture.

**Porting:** any web product with an E2E harness is 80% there — the video harness
is a thin layer (helpers + scenes + a config) over existing fixtures/emulators.

### 4b. Native surfaces → desktop automation + screen recorder

Browser automation cannot touch installers, tray icons, or native windows. The
2026 tool landscape: **pywinauto** (Win32/UIA, maintained), WinAppDriver
(paused), FlaUI (.NET-only). Owlette drives its Inno Setup installer wizard with
pywinauto (`capture-native/`), recorded via OBS/ffmpeg, performed remotely over
Parsec when needed.

**Pick the automation tool by what actually renders the pixels:**

- **True native UI** (installer wizards, tray icons/menus) → pywinauto/UIA.
  Inno's Delphi wizard is fully UIA-visible; tray menus are Win32. Two hard-won
  tray rules: never poll UIA while a popup menu is opening (one lookup ~1.2s
  after the click), and screenshot menus with `PrintWindow` +
  `PW_RENDERFULLCONTENT`, not `CopyFromScreen`.
- **Webview-based desktop apps** (Tauri/Electron — owlette's 3.0.0 desktop app)
  → **drive the shipped binary over CDP**, not UIA and not a WebDriver. Launch
  the installed exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`
  and attach Playwright via `connectOverCDP`: you get the app's real selectors
  and testids. UIA over a webview exposes CSS class soup, not stable names;
  tauri-driver targets dev builds and dies on single-instance apps (a second
  instance forwards its argv to the first and exits). Owlette's implementation:
  `web/e2e/desktop-screenshots/` — which also solves the *state* problem:
  `PROGRAMDATA`/`COMPUTERNAME` redirected to a fixture tree (the real install and
  running service are never touched), window layout pinned and restored, the live
  tray process killed by verified PID only, and a stub pairing helper that speaks
  the real line protocol so a deterministic pairing phrase is filmable without
  consuming a real device code. The video layer is that harness + the same
  ffmpeg recorder and pacing helpers as the web pipeline.
- **Recording** is an external ffmpeg subprocess (desktop-region ddagrab + NVENC,
  probe-gated, ffprobe-validated) — not the browser tool's built-in recorder,
  which is a debugging artifact, not tutorial footage. This requires an
  interactive, unlocked desktop session and a capable GPU; document those
  prerequisites or CI boxes will silently produce nothing.

### 4c. What NOT to automate

Short, one-time native flows (a tray right-click, a single dialog) can be cheaper
to perform by hand over a recorder than to script. Automate what you will
**re-capture on product change**; perform what you'll capture once.

---

## 5. Accuracy: scripts are code — review them like code

The single biggest failure mode found in practice: **writing scripts from a
summary of the product instead of the product.** An early owlette draft written
from an exploration agent's summary shipped a factual error a human caught.

The process that fixed it:

1. **Ground every claim in a code-cited fact sheet** before writing prose.
2. **Dual independent review** — two different AI reviewers (owlette used codex +
   claude, with a shared brief) fact-check every script claim against the
   codebase, findings reconciled in a written synthesis.
3. **Adjudicate disagreements by reading the code, never by vote.** The owlette
   round-2 audit (10 reviewers, total overlap) caught a documented-but-
   unimplemented safety gate precisely because 2/10 disagreed with 8/10 — and the
   code, not the majority, settled it.
4. **Expect product bugs.** A serious accuracy review of tutorials doubles as a
   product audit — owlette's rounds surfaced 4 real product bugs (one data-loss
   footgun, one security gap), three of which were then fixed in product *so the
   scripts could describe correct behavior instead of documenting around bugs.*
   Budget for this: sometimes the fix belongs in the product, not the script.
5. **Review artifacts live with the scripts** (`review/` — briefs, per-reviewer
   findings, reconciliation) so the *next* drift pass knows what was already
   settled.

---

## 6. Maintenance: the drift-audit loop

A tutorial series about a shipping product starts rotting the day it's written.
The maintenance loop (run after any major release wave, or ~quarterly):

1. **Scope the drift:** `git log --oneline --since=<scripts' last verified date>`
   plus the changelog. (Owlette 2026-08: 320 commits, 2.12.x → 3.2.0, including a
   full local-UI replacement — that's a *re-audit everything* signal.)
2. **Fan out one fact-checker per episode** (fresh context each): extract every
   product claim from both tracks of the script, verify each against *current*
   code with file:line evidence, and grade each affected beat:
   - `renamed` / `stale` / `changed` / `gone`
   - **revoice?** (spoken text must change → re-render that MP3)
   - **recapture?** (on-screen flow changed → re-run/re-write that scene)
   - episode verdict: `ok` → `touch-up` → `partial-rewrite` → `full-rewrite`
3. **In parallel:** a coverage-gap agent (features shipped since that no episode
   covers → new-episode proposals), a capture-infra agent (do the harnesses still
   run against today's app?), and a voiceover-asset agent (what audio exists, what
   would a re-render cost).
4. **A completeness critic** over the merged findings: what did nobody check?
5. **Then repair in dependency order:** product facts settled → scripts revised →
   revised scripts re-reviewed (step 5 above, lighter) → re-render only `revoice`
   beats → re-capture only `recapture` scenes → re-assemble affected episodes.

Because sync is per-beat, the repair cost is proportional to the *drift*, not to
the series size — that's the payoff of §1's architecture.

Calibration rules for the fact-checkers (hard-won): findings cite file:line or
they don't exist; check the changelog before flagging (an issue fixed upstream is
not a finding); a clean episode is a valid result; severity claims need a stated
user impact.

---

## 7. Owlette-specific current state (2026-08-25)

> This section is the live status snapshot; §§1–6 are the portable playbook.

- **Scripts:** 13 episodes written, dual-reviewed twice (2026-05), committed.
  The 2026-08-25 drift audit against 3.2.0 (`DRIFT-AUDIT-2026-08.md`) found:
  1 full rewrite (ep08 — Tauri app replaced the Tkinter GUI), 2 partial rewrites
  (ep02 pairing flow, ep12 cortex→hoot + inverted tier-3 beat), 9 touch-ups,
  1 clean (ep10). **26 of 84 beats need re-voicing; 58 MP3s survive.** Plus 2–4
  proposed new episodes (talons, day-zero, display layouts, fleet maintenance).
- **Voiceover:** all 84 per-beat MP3s + manifests rendered and verified in sync
  with the scripts (local-only — back them up). Settings recovered and now
  documented: eleven_v3, stability 0.30, style 0.0, PVC voice. `generate.py`
  needs the audit's HIGH fixes (persist settings in the manifest; `--changed`
  mode) **before** any re-render pass.
- **Web capture:** scenes exist for all 11 browser episodes; harness is current.
  Per-scene fixture/selector fixes are listed in the drift audit; re-running all
  scenes is near-free once they land. `web/e2e/videos/README.md` needs the
  ffmpeg-era rewrite.
- **Native capture:** installer wizard automation still works (premise rewrite
  needed — pairing hands off to the desktop app now); desktop-app capture =
  CDP video sibling of `web/e2e/desktop-screenshots/` per §4b; tray via the
  existing PowerShell/UIA script. No dedicated rig yet — this workstation
  (ffmpeg + NVENC verified) suffices.
- **Assembly:** DaVinci Resolve; not yet started for any episode.

---

## 8. Stack summary (one table)

| Layer | Tool | Why this one |
|---|---|---|
| Scripts | Markdown, dual-track, per-beat | Diffs/reviews like code; feeds every tool |
| Voice | ElevenLabs `eleven_v3`, PVC voice, per-beat MP3s | Re-render = cents; consistent delivery; user's real voice |
| Web capture | Playwright + seeded emulator fleet + pacing helpers | Deterministic, re-runnable, demo-quality data |
| Native capture | pywinauto + OBS/ffmpeg (+ see §7 for Tauri) | Only maintained Windows automation option; short flows can be manual |
| Recording | ffmpeg ddagrab/NVENC (web), OBS (native) | Quality + validated output |
| Assembly | DaVinci Resolve (free) | Per-beat drag-and-drop sync; zooms/callouts |
| Accuracy | Code-grounded fact sheets + multi-agent adversarial review | Scripts are claims about a codebase; treat them as such |
| Maintenance | Per-episode drift audits, per-beat repair | Cost proportional to drift, not series size |
