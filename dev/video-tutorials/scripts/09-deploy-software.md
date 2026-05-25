---
number: 9
slug: deploy-software
title: deploy software to many machines
est_duration: "9:00"
capture: web
scenario: deploy-roost-rolling
voice: null
model: null
---

# episode 9 — deploy software to many machines

> After this you can push a software installer to a whole fleet at once, silently, and retry any that fail.

## [b01] the use case
**SCREEN:** the deployments page with a mix of past deployments (completed, failed, in-progress).
**VOICEOVER:**
installing the same software on twenty machines by hand is nobody's idea of a good time.
deployments is owlette's answer: point it at an installer, pick your machines, and it does
every one of them for you — in the background, while you do something else.

## [b02] new deployment and templates
**SCREEN:** click "new deployment"; the "deploy software" dialog. Open the template dropdown showing system presets (grouped) and saved templates.
**VOICEOVER:**
click new deployment. first stop is the template dropdown. owlette ships with system
presets for common software, and you can pick one to auto-fill everything. or start from
a template you saved earlier. for now, let's build one from scratch.

## [b03] installer url and silent flags
**SCREEN:** fill the "installer URL" field (the filename auto-derives); fill "silent install flags" (placeholder /VERYSILENT /DIR="...").
**VOICEOVER:**
paste the installer's download url — owlette works out the filename automatically. then
the important field for unattended installs: silent flags. these are the switches that
tell an installer to run without popping dialogs on the remote machine — things like very
silent, or a custom directory. most installers document theirs; the presets already know
the common ones.

## [b04] the options that save you grief
**SCREEN:** show "parallel install (keep existing versions)" checkbox, and the "close running processes before install" section with the managed-process checklist + amber warning.
**VOICEOVER:**
two options worth knowing. parallel install keeps existing versions side by side instead
of replacing them. and "close running processes before install" — this one matters: if the
software you're updating is currently open, the install can fail. tick this and owlette
will close the apps first, warn you exactly which ones, and restart your managed processes
automatically afterward.

## [b05] choose your targets
**SCREEN:** the target machines list with online/offline badges; click "online only", then adjust with "select all" / individual checkboxes.
**VOICEOVER:**
now pick the machines. each shows whether it's online. "online only" selects every
reachable machine in one click — usually what you want, since an offline machine can't
install anything right now. or check them individually for a careful rollout.

## [b06] deploy and watch
**SCREEN:** click "deploy to N machines"; the deployment expands showing per-machine progress: pending → closing processes → downloading → installing → completed; a cancel control for the in-flight deployment.
**NOTE:** BLOCKED — do not record episode 9 yet. The agent currently refuses any remote install that lacks a sha256 checksum (agent/src/owlette_service.py:3238-3248), but the deploy dialog has no checksum field and createDeployment only sends one if provided — so a dashboard-created deployment is rejected before it installs. This is a product gap to resolve (add a checksum field / auto-compute) before this end-to-end flow can be demonstrated.
**VOICEOVER:**
hit deploy, and you get a live progress board. each machine moves through its steps —
closing any apps you flagged, downloading, installing, then completed — with progress as
it goes. change your mind partway through? you can cancel the deployment and it stops the
machines that haven't finished. you watch the whole fleet update in real time.

## [b07] retry the stragglers
**SCREEN:** a failed deployment; click "retry failed"; a new deployment "<name> (Retry)" targeting only the failed machines.
**VOICEOVER:**
some will fail — a machine was off, an installer hiccupped. that's normal. retry failed
spins up a fresh deployment aimed only at the machines that didn't make it, so you're not
re-running the whole batch. that's deployments. next, a different kind of distribution —
shipping your actual project files with roost.
