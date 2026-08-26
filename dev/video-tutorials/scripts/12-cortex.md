---
number: 12
slug: cortex
title: "hoot: manage machines by chat"
est_duration: "8:00"
capture: web
scenario: diagnose-cortex-chat
voice: null
model: eleven_v3
---

# episode 12 — hoot: manage machines by chat

> After this you can ask hoot to diagnose and fix machines in plain language, and you'll know exactly when it pauses for your approval.

**NOTE:** this file, its slug, its rendered MP3 directory (`voiceover/out/12-cortex/`) and the capture scene id all deliberately keep the **wire** name `cortex`. The product was renamed to **hoot** in 1c628a54; only the wire/storage/asset names stayed behind (see `web/lib/hoot/WIRE_NAMES.md`). Every word of display copy, on-screen text and narration in this episode says **hoot**. Do not rename the file — it would orphan the rendered audio and break `recordScene` in `web/e2e/videos/12-cortex.video.ts`.

**NOTE:** every beat in this episode is revoiced — the old take (2026-05-30) predates the rename, the approval gate and async turns, and is unusable. Full re-record of the scene.

## [b01] what hoot is
**SCREEN:** the hoot chat page at `/hoot/<id>` with the seeded incident conversation open; the `hoot` nav item highlighted in the header.
**VOICEOVER:**
[warm] hoot is owlette's assistant, built right into the dashboard. instead of clicking
through cards and menus, you just ask. which machines look unhealthy? why did the lobby
display freeze? it investigates using everything owlette already knows, then answers in
plain language. and when you ask it to, it can act.

## [b02] one key, one place
**SCREEN:** user menu → account settings → the **hoot** section. show the provider select (Anthropic (Claude) / OpenAI), the model select, and the api key field with the line "your key is encrypted with AES-256 and never leaves the server."
**VOICEOVER:**
one setup step, and it lives in your account settings, under hoot. pick a provider —
anthropic or openai — pick a model, and paste in your own api key. it's encrypted, and it
never leaves the server. there's exactly one place a key lives now: chat, talons, their
visual checks, and automatic investigations all draw on somebody's account key.

## [b03] point it at something
**SCREEN:** the target selector at the top of the chat (aria-label "hoot target") — open it to show **All Machines** with the online count, then the individual machines. Pick a machine; the chat resets to a new conversation.
**VOICEOVER:**
at the top of the chat, pick what hoot is pointed at. one machine when you're
troubleshooting a single box, or all machines when you want a fleet-wide answer — like
who's low on disk. switching the target opens a fresh conversation scoped to that target,
so each thread stays about one thing.

## [b04] the diagnosis
**SCREEN:** scroll the seeded conversation — the user's "what crashed at 3am?", hoot's exit-code / auto-restart / CUDA-cause answer, and the inline `checkLogs` tool card. Expand the card.
**NOTE:** capture method — the chat needs a live LLM, so the harness can't type a prompt and await a real response. Film the pre-seeded conversation by scrolling; don't type. Applies to b04 and b05.
**VOICEOVER:**
then just ask. what crashed at three am? hoot goes and reads — logs, metrics, process
state — and comes back with the story. this process crashed, here's the exit code, it
auto-restarted, here's the likely cause. every tool it used shows up as a card in the
thread, and you can open any of them.

## [b05] asking it to act
**SCREEN:** the approve/deny card — "hoot wants to run the privileged `run_powershell` tool on media-server-stage. approve to continue, or expand to inspect the input." with **approve** and **deny** buttons and the amber "awaiting approval" label.
**NOTE:** the fixture must gain a seeded assistant tool part with `state: 'approval-requested'` and an `approval: { id }` so this banner renders (`ChatWindow.tsx` → `ToolCallCard.tsx`). It does not exist yet — b05 cannot be filmed until it's seeded.
**VOICEOVER:**
now ask it to do something. restarting a configured process, grabbing a screenshot — those
are routine, and hoot just does them. the heavier stuff — a shell command, a file write,
restarting the whole machine — stops and asks first. you get a card: hoot wants to run this
tool, on this machine. approve, or deny.

## [b06] the guardrails
**SCREEN:** the right side of the hoot header — the shield toggle reading **approval required**, and beside it the per-machine toggle reading **hoot active**. Hover each for its tooltip; open the confirm dialog on the machine toggle to show the "the agent will stay online for monitoring" wording, then cancel.
**VOICEOVER:**
[reassuring] three guardrails, stacked. your role sets the ceiling — members get read-only,
only site admins reach the privileged tools. the approval gate is on by default, site-wide,
and only an admin can flip it, from the shield in the hoot header. every machine has
its own hoot switch — set it to inactive and monitoring carries on, but hoot can't act there.

## [b07] the tab isn't the boss
**SCREEN:** a running tool card with its **cancel** control, and the send button swapped for the square **stop response** button. Then reload the page mid-turn and show the chat reattaching and streaming from where it left off.
**VOICEOVER:**
a hoot turn runs on the server, not in your browser. close the tab mid tool call, come
back, the answer's waiting. stop halts the whole turn server-side, not just your view.
and each running tool has its own cancel.

## [b08] hoot on its own
**SCREEN:** the hoot sidebar with an autonomous conversation carrying its **auto** badge; then account settings → alerts, on the **hoot escalation alerts** switch.
**NOTE:** there is no dashboard control that turns autonomous mode on — `autonomousEnabled` is set out of band on `sites/{siteId}/settings/cortex` (`web/content/docs/dashboard/hoot.mdx:210-214`). So this beat films the *result* (an `auto` conversation in the sidebar) and the escalation-alerts switch, never a "switch it on" click.
**VOICEOVER:**
hoot doesn't only work when you're watching. when autonomous investigations are switched
on for your site, a crash can kick off its own diagnosis — read the logs, try a restart,
write up what happened. if it can't fix it, you get an escalation email instead of silence.
next: rules that watch for that kind of thing and act on their own — talons.
