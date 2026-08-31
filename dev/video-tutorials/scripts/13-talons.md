---
number: 13
slug: talons
title: "talons: rules that watch and act"
est_duration: "8:00"
capture: web
scenario: automate-talons-list
voice: null
model: eleven_v3
---

# episode 13 — talons: rules that watch and act

> After this you can build a talon that watches a schedule, a threshold, or an event, optionally has hoot look at the screen, and then acts — and you'll know exactly how far it's allowed to go.

## [b01] a wall goes black at 3am
**SCREEN:** `/talons` on site-A, the seeded list of seven talons. Slow scroll top to bottom: "doors open — lobby wall is live", "gpu pinned on the render node", "nightly restart — media servers", "projector dropped offline", "touchdesigner crash recovery", "update guard — sundays", "weekly health report".
**NOTE:** capture precondition — any beat that fires a hoot action against a real machine needs the agent's one-time hoot CLI fetch already warm (`%ProgramData%\Owlette\cache\claude-cli\claude.exe`, ~240 MB, downloaded on first use). Run one hoot action on the capture machine the day before, or the take stalls on the download.
**VOICEOVER:**
[warm] three in the morning, the lobby wall drops to black. nobody's there. it stays that
way until someone walks in at nine and notices. talons are how owlette watches when you're
not watching — a rule that waits for something to happen, checks whether it actually
matters, then does something about it.

## [b02] trigger, condition, outputs
**SCREEN:** click "create talon" → the "new talon" dialog. Hold on the three cards left to right with the connector wires between them: TRIGGER | CONDITION | OUTPUTS. Open the trigger dropdown so all three options show — "on a schedule", "when a metric crosses", "when an event happens" — then close it.
**VOICEOVER:**
every talon is the same three-part sentence. a trigger — when. a condition — an optional
check before it acts. and outputs — what actually happens. the editor lays them out left
to right, wired together, so you read it as a pipeline, not a form. authoring is a site
admin job; anyone with site access can read what they built.

## [b03] build one live
**SCREEN:** trigger → "when an event happens", tick `process_crash` in the event list. Condition stays on "always run outputs", machines stays "all machines". Outputs row 1: type "command" → "restart process" → pick TouchDesigner. "add output" → row 2 type "email". Type the name "touchdesigner crash recovery" → "create talon" → the row appears in the list.
**NOTE:** the `command` output type only appears in the picker for a site admin — capture signed in as the admin fixture user.
**VOICEOVER:**
let's build one. trigger: when an event happens — tick process crash. condition: leave it
alone, always run. outputs: restart the process, then add a second one, email. name it,
create talon. now if touchdesigner dies at three in the morning it comes straight back, and
the people who asked for talon alerts hear about it.

## [b04] start from a preset
**SCREEN:** reopen "create talon"; open the "start from a template…" picker in the dialog header. Show the group labels — "ready to use" / "needs a detail" — then choose "morning wall check" and let every field populate.
**NOTE:** the grouping is per-viewer: with an ai key saved in settings → hoot all six built-ins sit under "ready to use"; with no key the five ai-backed ones drop to "needs a detail" with the hint "needs an ai api key — add one in settings → hoot". Capture whichever state you want on screen by seeding (or clearing) the fixture user's llm key first.
**VOICEOVER:**
you don't have to start blank. six presets ship with every site — morning wall check, crash
triage, weekly health report, exe went missing, wall check after restart, and update guard.
pick one and every field fills in for you. the picker sorts them by whether they'll run
as-is, or whether something's still missing, like an ai key.

## [b05] the visual check
**SCREEN:** in the condition card, switch to "visual check". Show the "what should be on screen" box with the wall expectation text, the monitor field ("0 = all monitors, 1 = primary"), and the hint beneath: "hoot grabs a fresh screenshot and checks it against this… the outputs fire when the check FAILS." Cut to a run row on the list showing `verdict: fail — <reason>`.
**VOICEOVER:**
now the part with no equivalent anywhere else. switch the condition to visual check and
write what should be on screen, in plain english. when the talon fires, owlette grabs a
fresh screenshot and hoot judges it against your sentence — pass or fail, with a one-line
reason for what it actually saw. the outputs only run when the check fails.

## [b06] let hoot act
**SCREEN:** change an output's type to "hoot"; show the directive box, then the "let hoot act" switch and the copy under it. Toggle it on, hold two beats, toggle it back off.
**VOICEOVER:**
[reassuring] one output type is hoot itself. you write a directive; it carries that out in
a chat you can read afterwards. by default it can only look. turn on let hoot act and it
can also restart a process, restart a service, free up disk space. it can never run a
script, write a file, deploy software, or restart the machine — whatever the directive says.

## [b07] run history, cooldown, auto-disable
**SCREEN:** expand a talon row's chevron → the "recent runs" block. Show the run rows: status glyph, trigger summary + machine, the `2/2 sent` count, duration, "12m ago", and a "view hoot chat" link on the row that started one. Hover the "run now" (↺) and pause buttons in the row's action cluster.
**NOTE:** `automate-talons-list` seeds talon docs only, NOT `sites/{siteId}/talon_runs` — expanding a row in that scenario shows the "no runs yet" empty state. Either extend the fixture with run docs before recording, or capture this beat against a live dev site with real history.
**VOICEOVER:**
every firing is recorded. open a talon's chevron and you get its recent runs — what set it
off, the verdict, how many outputs went out, and a link into the hoot chat if one ran. a
cooldown stops a flapping machine firing the same rule in a loop. a talon that fails ten
runs in a row switches itself off and says why.

## [b08] the one to turn on first
**SCREEN:** open "create talon" → template picker → "update guard"; the fields fill in with the sunday 07:00 schedule and a single hoot output, and the "let hoot act" switch is OFF. Toggle it on, then cut back to the "update guard — sundays" row in the list and pull out to the whole list of seven.
**NOTE:** show the switch state from the PRESET (off), not from the seeded `talon-update-guard` fixture row — that fixture instance is written with `allowActions: true` and would contradict the line about it arriving without permission to act.
**VOICEOVER:**
the one i'd turn on first is update guard. every sunday morning it re-asserts your windows
update window and re-suppresses those full-screen setup screens, so an update never hijacks
the exhibit. it arrives without permission to act, though — turn on let hoot act and it
fixes the drift instead of just reporting it. next up: who gets told when something goes
wrong.
