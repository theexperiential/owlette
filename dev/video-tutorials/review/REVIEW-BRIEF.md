# Accuracy review brief — tutorial scripts

**Goal:** verify the 13 layperson tutorial scripts in `dev/video-tutorials/scripts/*.md`
are **factually accurate** against the real Owlette codebase. These scripts make claims —
in both the `**VOICEOVER:**` spoken text and the `**SCREEN:**` directions — about how the
app actually behaves, what buttons are labeled, where features live, and what permissions
apply. A viewer will follow them literally, so wrong claims must be caught.

**Method**
- Read each script, then verify its claims against the actual code. Use ripgrep to locate
  components/routes; read only targeted line ranges (do NOT cat large files).
- Web UI lives in `web/` (App Router pages + `web/components/`); the agent lives in
  `agent/src/` + `agent/owlette_installer.iss`.

**For every issue, report:**
- script file + beat id (e.g. `04-keep-a-process-alive.md [b03]`)
- the quoted claim
- the contradicting evidence at `file:line`
- severity: **blocker** (wrong or misleading to a viewer) / **minor** (imprecise but not
  misleading)
- a corrected version of the line

Also list any claim you **could not verify**. **Ignore tone, style, and the lowercase
convention — accuracy only.** Do **not** edit the scripts; only write findings.

**Known-tricky areas (verify independently — don't assume these are right or wrong):**
- where the installer is downloaded from (header button vs the "+ add machine" modal vs
  a public `/download` route)
- install pairing: does the browser auto-open, or does the installer prompt first?
- where agent credentials are stored (`.tokens.enc` vs Windows Credential Manager)
- machine remote-action permissions: site-admin vs superadmin; which actions are open to
  all roles (screenshot / live view / mute)
- usage color bands (how many, which colors at which thresholds) and temperature bands
- whether there's an "invite user" flow, or users self-register
- where the Cortex LLM key is configured (account settings vs the cortex page); and which
  roles can trigger which tool tiers
- process status labels and the launch-mode option labels (Off / Always On / Scheduled)
- schedule preset names; deployment (3rd-party installers) vs roost (project files)
