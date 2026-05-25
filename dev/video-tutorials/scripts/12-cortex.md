---
number: 12
slug: cortex
title: cortex — manage machines by chat
est_duration: "8:00"
capture: web
scenario: diagnose-cortex-chat
voice: null
model: null
---

# episode 12 — cortex: manage machines by chat

> After this you can ask cortex to diagnose and fix machines in plain language, and you'll know exactly when it pauses for your approval.

## [b01] what cortex is
**SCREEN:** the cortex chat page with an incident conversation open.
**VOICEOVER:**
cortex is owlette's built-in assistant. instead of clicking through cards and menus, you
just ask: "which machines look unhealthy?" or "why did the lobby display freeze?" — and it
investigates using everything owlette already knows, then answers in plain language. and
when you ask it to, it can act.

## [b02] one-time setup
**SCREEN:** Account Settings → "cortex" tab: provider dropdown (Anthropic / OpenAI), a model dropdown, and the API key field ("encrypted with AES-256, never leaves the server").
**VOICEOVER:**
one setup step first, and it lives in your account settings under cortex — not on the chat
page. you choose a provider, anthropic or openai, pick a model, and paste in your own api
key. that key is encrypted and stays server-side. this is bring-your-own-key, so cortex
runs on your account, under your control.

## [b03] pick what it's talking to
**SCREEN:** the chat's machine selector at the top — choose a single machine, or the whole site.
**VOICEOVER:**
at the top of the chat you choose cortex's focus: a single machine when you're
troubleshooting one box, or the entire site when you want a fleet-wide answer like "is
anyone low on disk?" same conversation, different scope.

## [b04] ask a question
**SCREEN:** the seeded incident conversation already open at /cortex/<id>; scroll through the user's "what crashed at 3am?", cortex's diagnosis, and the inline tool-call card.
**NOTE:** capture method — the chat needs a live LLM, so the harness can't type a live prompt and await a response. Film the pre-seeded conversation (scroll it); don't type. Applies to b04 and b05.
**VOICEOVER:**
start by just asking. "what crashed at three am?" cortex tells you: this process crashed,
here's the exit code, it auto-restarted, here's the likely cause — all from reading the
logs and metrics, which it does on its own without changing anything. and when it needs to
actually see the display, it can capture a fresh screenshot too.

## [b05] ask it to act
**SCREEN:** scroll to the seeded turns where cortex restarts a process (routine tier-2) and where a privileged tier-3 action (reboot / shell) is carried out.
**NOTE:** PRODUCT GAP — do NOT script a "cortex pauses to confirm" beat. The tier-3 confirmation gate is currently unimplemented: `requiresConfirmation` (web/lib/mcp-tools.ts) is never called, and cortexStream.server.ts hands all allowed tools (tier-3 included for admins) to buildExecutableTools, which auto-runs them. The in-app docs (web/content/docs/dashboard/cortex.mdx) also claim the gate and need the same fix. This beat describes the actual behavior (admin tier + per-machine switch are the real controls), not a per-step approval.
**VOICEOVER:**
now ask it to do something. "restart touchdesigner here" is a routine action — cortex does
it directly. the heavier operations, like rebooting a machine or running a shell command,
are its privileged tier. the important thing to understand: cortex carries these out when
you ask — it isn't going to pause and make you re-confirm each one. so the safety here
isn't a per-step prompt; it's about who you let use cortex, and which machines you let it
touch. that's exactly what we lock down next.

## [b06] guardrails
**SCREEN:** the per-machine "cortex active / cortex inactive" power toggle.
**VOICEOVER:**
two guardrails worth knowing. first, who can do what: members can ask cortex anything
read-only, but only admins can authorize those privileged actions. second, every machine
has a cortex on-off switch — flip it to inactive and cortex keeps monitoring but can't
run any actions on that machine, manual or automatic. powerful, but always on a leash.
last episode: when something does go wrong, how to read the story in your logs.
