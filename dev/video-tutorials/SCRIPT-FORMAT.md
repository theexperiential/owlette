# Script format

Every episode script is one markdown file in `scripts/`, named `NN-slug.md`
(e.g. `02-install-and-pair.md`). The format is **dual-track**: spoken narration
and on-screen direction live side by side, but only the narration is ever sent to
ElevenLabs.

This file is also the **parser contract** for `voiceover/generate.py`. If you change
the format, update the parser.

---

## File structure

```markdown
---
number: 2
slug: install-and-pair
title: install owlette & pair your first machine
est_duration: "6:00"
capture: native            # web | native | mixed
scenario: null             # seedScreenshotFixtures scenario id, or null for native
voice: null                # optional ElevenLabs voice_id override (else use .env)
model: null                # optional model_id override (else use .env)
---

# episode 2 — install owlette & pair your first machine

> One-line statement of what the viewer can do after watching.

## [b01] cold open
**SCREEN:** fresh windows desktop, the installer .exe on the desktop.
**VOICEOVER:**
[warm] let's get owlette running on a brand-new machine. start to finish, this
takes about two minutes — and you never have to log in on the machine itself.

## [b02] running the installer
**SCREEN:** double-click Owlette-Installer-v3.0.0.exe; UAC prompt → yes.
**VOICEOVER:**
double-click the installer. windows will ask for admin rights — that's expected,
owlette installs as a service so it can keep your apps alive across reboots.
```

---

## The two front-matter rules that matter

- `capture` tells you which harness produces the footage: `web` (Playwright),
  `native` (pywinauto/OBS), or `mixed` (some beats each — note the surface per beat
  in the `**SCREEN:**` line).
- `scenario` is the `seedScreenshotFixtures(...)` scenario id the web harness seeds
  before capturing (e.g. `dashboard-mixed-states`). `null` for native episodes.

---

## Beats

A **beat** is the atomic unit of sync: one chunk of narration + the screen action it
plays over. Each beat becomes one MP3 (`epNN-bNN.mp3`).

A beat **must** look like this, in this order:

```
## [bNN] short human title
**SCREEN:** what is on screen / what action happens / any zoom or callout note.
**VOICEOVER:**
the spoken words. one or more paragraphs. this is the ONLY text sent to ElevenLabs.
```

- Beat heading: `## [bNN] title` where `NN` is zero-padded (`b01`, `b02`, …).
- `**SCREEN:**` comes **before** `**VOICEOVER:**`. It is direction; it is never spoken.
- `**VOICEOVER:**` text runs until the next `## [bNN]` heading (or end of file). Keep
  any further direction (`**B-ROLL:**`, `**NOTE:**`) **above** the voiceover, not below.

### Other direction labels (all stripped from narration)
`**SCREEN:**`, `**B-ROLL:**`, `**ON-SCREEN:**` (lower-third / caption text),
`**NOTE:**` (a note to the editor/recorder). Put them before `**VOICEOVER:**`.

---

## ElevenLabs audio tags (v3 only)

When `model` resolves to `eleven_v3`, bracketed tags in the voiceover are interpreted
as performance direction: `[warm]`, `[pause]`, `[reassuring]`, `[excited]`, etc.

When the model is **not** v3 (e.g. the default `eleven_multilingual_v2`), `generate.py`
**strips** every `[...]` tag before sending, so the same script works on both models —
v2 won't read "warm" aloud. Write tags freely; they're free insurance.

Use them sparingly — a tag every sentence reads as overacting. One per beat, max.

---

## Writing voice for TTS (house style)

- **Lowercase, conversational** — match Owlette's UI voice. Short sentences.
- **Spell it how it should sound.** "owlette" not "Owlette"; "three-oh" not "3.0" if
  you want it spoken that way; "see-pee-you" only if you must (usually "CPU" is fine).
- **Punctuation is pacing.** Commas and em-dashes become micro-pauses (especially on
  v3). Periods are full stops. Use them deliberately.
- **No stage directions in the spoken text.** "Now click the plus button" is fine
  (it's spoken); "(user clicks plus)" is not — that belongs in `**SCREEN:**`.
- **One idea per beat.** If a beat's narration runs past ~25 seconds, split it — it
  makes editing sync far easier.

---

## Validating a script parses

```bash
cd dev/video-tutorials/voiceover
python generate.py ../scripts/02-install-and-pair.md --dry-run
```

`--dry-run` parses, prints every beat's spoken text + character count + estimated
ElevenLabs credit cost, and makes **no** API calls. Always dry-run before spending
credits.
