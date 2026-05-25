---
number: 10
slug: distribute-with-roost
title: distribute project folders with roost
est_duration: "9:00"
capture: web
scenario: deploy-roost-rolling
voice: null
model: null
---

# episode 10 — distribute project folders with roost

> After this you can upload a project folder once, sync it to a set of machines, and roll back to any previous version.

## [b01] what roost is
**SCREEN:** the roost page with the "stage show" roost and its version history.
**VOICEOVER:**
deployments installs software. roost ships your content — the project folders themselves.
think of a roost as a destination: a set of files that lives on specific machines, where
every update goes out as a new, numbered version you can always roll back from. perfect for
the show file, the media pack, the exhibit content.

## [b02] new roost
**SCREEN:** click "new roost"; the dialog. Fill "roost name", optional "description" ("what changed?"), and the source toggle "upload files" vs "by url".
**VOICEOVER:**
click new roost and give it a name. there's a description field — use it like a commit
message, "fixed the broken video," so future-you knows what each version was. then choose
your source: upload a folder straight from here, or point at a zip by url.

## [b03] upload the folder
**SCREEN:** drag a folder into the dropzone; show the progress — hashing, checking for duplicates, uploading with throughput/ETA. Then the "extract to" field with the amber allowed-roots warning for paths outside ~/Documents.
**VOICEOVER:**
drag your folder in and owlette gets clever: it fingerprints every file and only uploads
the pieces it doesn't already have, so re-publishing a project where one video changed is
fast. then "extract to" — where the files land on each machine. by default that's under
the machine's documents folder. if you point it somewhere else, owlette warns you, because
the agent only writes to approved locations for safety — you'd add that path to its config
first.

## [b04] targets and distribute
**SCREEN:** the target machines checklist; click "upload and distribute"; show per-target status pills: queued → downloading → assembling → synced (the agent's committed state), with the rollup pill (synced / syncing / partial).
**VOICEOVER:**
pick which machines get this roost, then upload and distribute. each target reports its own
progress — downloading, assembling, then committing the files into place, which shows as
synced — and a summary pill rolls the whole fleet up into one word: synced, syncing, or
partial. you see at a glance whether everyone got it.

## [b05] ship a new version
**SCREEN:** open the existing roost; click "+ new version"; note name / extract path / targets are locked; just drop a new folder + write a description.
**VOICEOVER:**
when the project changes, you don't make a new roost — you add a version. open the roost,
hit new version, and the destination and machine list are already locked in. you just drop
the updated folder and describe what changed. owlette pushes the difference to every target.

## [b06] roll back
**SCREEN:** the version history rows (number, time, description, current marked with an emerald dot); open a row's three-dot menu: edit description, rollback to this version, copy version id, view files, diff against current.
**VOICEOVER:**
and here's the safety net. every version stays in the history. opened to a venue this
morning and the new build has a bug? open the version menu, pick rollback, and every
machine returns to the previous version in moments. you can compare versions, see exactly
which files changed, and never be more than one click from a known-good state. next, let's
bring your team in and set up alerts so owlette tells you when something needs you.
