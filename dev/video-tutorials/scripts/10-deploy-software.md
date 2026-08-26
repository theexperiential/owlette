---
number: 10
slug: deploy-software
title: deploy software to many machines
est_duration: "9:00"
capture: web
scenario: deploy-roost-rolling
voice: null
model: eleven_v3
---

# episode 10 — deploy software to many machines

> After this you can push a software installer to a whole fleet at once, silently, and retry any that fail.

## [b01] the use case
**SCREEN:** the deployments page with a mix of past deployments (completed, failed, in-progress). Pan the header once: `update owlette` sits beside `new deployment` (app/deployments/page.tsx:585, 591). Open one row's ⋮ so `uninstall software` (page.tsx:197) is on camera for a beat, then close it.
**NOTE:** both are silent nods only — episode 17 (keeping the fleet current) walks the update button and remote uninstall properly. Nothing about either is spoken here.
**VOICEOVER:**
installing the same software on twenty machines by hand is nobody's idea of a good time.
deployments is owlette's answer: point it at an installer, pick your machines, and it does
every one of them for you — in the background, while you do something else.

## [b02] new deployment and templates
**SCREEN:** click "new deployment"; the "deploy software" dialog (DeploymentDialog.tsx:405). Open the template dropdown showing system presets grouped under their category labels (:449-463) and the "Saved" group of user templates (:466-479).
**NOTE:** fixture gap — seedDeployRoostRolling seeds no system_presets and no installer_templates (e2e/screenshots/fixtures.ts:790-900), so the dropdown renders only "none". Seed both before capture; helper exists at web/e2e/helpers/coverageSeed.ts:256 (seedSystemPreset).
**VOICEOVER:**
click new deployment. first stop is the template dropdown. owlette ships with system
presets for common software, and you can pick one to auto-fill everything. or start from
a template you saved earlier. for now, let's build one from scratch.

## [b03] installer url and silent flags
**SCREEN:** fill the "installer URL" field (#installer-url, DeploymentDialog.tsx:557 — the filename auto-derives underneath). A checksum row sits directly under it (:575): it reads "computing sha256 checksum…" while the server hashes, then resolves to a green-ticked "sha256: <first twelve>…<last eight>" (InstallerChecksumStatus.tsx:64, 76-83). Then fill "silent install flags" (#silent-flags, :582, placeholder /VERYSILENT /DIR="...").
**NOTE:** the emulator can't reach a real download host, so the row will land amber — "failed to compute checksum — retry or enter manually" (InstallerChecksumStatus.tsx:88-110). Click "enter manually" and fill #manual-checksum with a 64-hex digest, exactly as web/e2e/specs/dispatch/create-deployment.spec.ts:59-63 does. Deploy stays blocked until a digest exists (DeploymentDialog.tsx:319-328).
**VOICEOVER:**
paste the installer's download url — owlette works out the filename automatically. then
the important field for unattended installs: silent flags. these are the switches that
tell an installer to run without popping dialogs on the remote machine — things like very
silent, or a custom directory. most installers document theirs; the presets already know
the common ones.

## [b04] the options that save you grief
**SCREEN:** show "parallel install (keep existing versions)" checkbox (#parallel-install, DeploymentDialog.tsx:596, label at :602-603), and the "close running processes before install" section (:619) with the managed-process checklist + amber warning.
**NOTE:** the checklist only renders once targets are selected — before that the panel reads "select target machines to see managed processes" (DeploymentDialog.tsx:654-657), and seedMachine writes no processes at all. Either pick targets first (b05's action) and seed processes, or shoot the amber warning from #additional-processes alone.
**VOICEOVER:**
two options worth knowing. parallel install keeps existing versions side by side instead
of replacing them. and "close running processes before install" — this one matters: if the
software you're updating is currently open, the install can fail. tick this and owlette
will close the apps first, warn you exactly which ones, and restart your managed processes
automatically afterward.

## [b05] choose your targets
**SCREEN:** the target machines list with online/offline badges; click "online only (N)" (DeploymentDialog.tsx:762), then adjust with "select all" / individual checkboxes (:771).
**VOICEOVER:**
now pick the machines. each shows whether it's online. "online only" selects every
reachable machine in one click — usually what you want, since an offline machine can't
install anything right now. or check them individually for a careful rollout.

## [b06] deploy and watch
**SCREEN:** click "deploy to N machines" (DeploymentDialog.tsx:827); the deployment expands showing per-machine progress: pending → closing processes → downloading → installing → completed, with a percentage during download and install (page.tsx:245-247); a cancel control on every unfinished target (page.tsx:271-276).
**NOTE:** no live agents in the harness, so a freshly created deployment would sit at pending — expand the seeded in-progress record `depl-stage-show-v4` (fixtures.ts:826-846: three completed, one installing at 64%, the rest pending) for the progress board.
**VOICEOVER:**
hit deploy, and you get a live progress board. each machine moves through its steps —
closing any apps you flagged, downloading, installing, then completed — with progress as
it goes. change your mind partway through? you can cancel the deployment and it stops the
machines that haven't finished. you watch the whole fleet update in real time.

## [b07] retry the stragglers
**SCREEN:** the failed row `depl-touchdesigner-driver-update` (fixtures.ts:867-882 — one target failed on "msi exit code 1603"). Open its ⋮ → "retry failed" (page.tsx:185): the same record flips to in progress, the failed target returns to pending, toast "retrying deployment for 1 machine(s)" (page.tsx:380). Then expand the row and hover the per-target retry arrow, tooltip "retry this machine" (page.tsx:259-266).
**VOICEOVER:**
[reassuring] some will fail — a machine was off, an installer hiccupped. that's normal.
retry failed re-runs the same deployment for just those machines. no duplicate record, and
nothing reinstalls on the ones that worked. or open the deployment and hit the retry arrow
on a single machine. that's deployments. next, a different kind of distribution — shipping
your actual project files with roost.
