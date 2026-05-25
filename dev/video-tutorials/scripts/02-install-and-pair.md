---
number: 2
slug: install-and-pair
title: install owlette & pair your first machine
est_duration: "6:00"
capture: native
scenario: null
voice: null
model: null
---

# episode 2 — install owlette & pair your first machine

> After this you can install the agent on a fresh windows machine and pair it to your dashboard — authorizing it from any signed-in browser, not by setting up credentials on the machine.

## [b01] cold open
**SCREEN:** a clean windows 11 desktop over parsec; the installer exe sitting on the desktop.
**NOTE:** record this whole episode on the fresh demo machine via parsec + obs.
**VOICEOVER:**
[warm] let's get owlette running on a brand-new machine. start to finish this takes
about two minutes — and here's the part people don't expect: you don't set up any logins
or credentials on the machine itself. it gets authorized from your dashboard.

## [b02] where the installer comes from
**SCREEN:** the dashboard header — the download icon button (tooltip "download owlette agent v<current version>"). Click it; the installer downloads. Note the copy-link button right beside it.
**NOTE:** the same download link also lives inside the "+ add machine" modal's "enter code" tab, and there's a public owlette.app/download permalink — but the header button is the simplest path to show.
**VOICEOVER:**
you get the installer right from your dashboard — there's a download button up in the
header. grab it once and you can reuse that same installer file on every machine you set
up. there's a copy-link button next to it too, which is handy when you're about to remote
into a machine and just want to paste the link over.

## [b03] running the installer
**SCREEN:** double-click the installer; the windows user-account-control prompt appears; click yes.
**VOICEOVER:**
double-click it. windows asks for administrator rights — that's expected, and it's
important. owlette installs itself as a windows service so it can keep your apps alive
even across reboots and logouts. click yes.

## [b04] what it's installing
**SCREEN:** the installer progress screen; optional lower-third callout: "installs as a service · auto-starts on boot".
**ON-SCREEN:** installs as a service • auto-starts on boot
**VOICEOVER:**
in the background it's doing three things: copying the agent onto the machine, setting
it up as an always-on service, and adding a small owl icon to your system tray so you
can check on it locally. you don't have to configure any of that — it's automatic.

## [b05] the pairing phrase
**SCREEN:** during setup a pairing console window appears showing a three-word phrase, e.g. "silver-compass-drift"; zoom in on the phrase. (The installer's own final screen just says setup finished.)
**VOICEOVER:**
during setup, owlette shows you a pairing phrase — three simple words — in a little
pairing window. this is how the machine proves it's allowed to join your dashboard. think
of it like a one-time handshake; it expires in ten minutes if it isn't used.

## [b06] opening the pairing page
**SCREEN:** the installer console prompt "open browser on this machine? [y/N]"; press y; the default browser opens owlette.app/add with the phrase pre-filled. (Alternative b-roll: opening owlette.app/add on a laptop and typing the phrase in.)
**VOICEOVER:**
owlette offers to open a browser right there on the machine — press y, and it lands on
the owlette add-a-machine page with your pairing phrase already filled in. prefer to do
this from your own laptop? just skip the prompt, open owlette dot app slash add on any
device, and type the three words in yourself. either way, you only ever sign in once — to
owlette, in a browser — and if you'd rather the new machine never see a login at all, just
authorize from your laptop instead.

## [b07] choosing a site
**SCREEN:** the add page — a "site" dropdown; pick "main gallery"; the authorize button lights up.
**VOICEOVER:**
now pick a site. a site is just a group of machines — one per venue, or per client, or
per room, however you like to organize. i'll drop this one into "main gallery." then
click authorize.

## [b08] the machine appears
**SCREEN:** cut to the dashboard; within ~30 seconds a new machine card pops in, status pill turns green, heartbeat starts.
**VOICEOVER:**
[satisfied] and that's it. switch back to your dashboard, and within about thirty
seconds the new machine shows up — green status, a live heartbeat, ready to go. behind
the scenes its credentials were saved in an encrypted, machine-locked file; you never had
to touch a config file or copy a key.

## [b09] recap & the other two ways
**SCREEN:** back to the add-machine modal showing both tabs: "enter code" and "generate code".
**VOICEOVER:**
so that's the browser flow — perfect for a single machine. there are two more ways to
add machines: you can type the pairing phrase straight into the dashboard, or, for bulk
rollouts, generate a code first and feed it to a silent install — no clicking at all.
we'll come back to bulk deployment later in the series. next up: the dashboard itself.
