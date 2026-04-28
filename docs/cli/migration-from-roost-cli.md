---
hide:
  - navigation
---

# migrating from `roost` cli → `owlette` cli

The cli was renamed in v0.2.0. The package, the binary, the env-var prefix, and the config-path prefix all moved from `roost*` to `owlette*`. Command shapes (`auth login`, `roost push`, `key create`, etc.) and exit codes are **unchanged** — only the surrounding scaffolding moved.

This page is for dev testers who already use the legacy `roost` binary and need to migrate. New users can skip straight to the [overview](overview.md).

> **hard removal date**: 2026-10-01. After that, the legacy paths listed below stop working. Plan to migrate before then.

---

## what changed

| area | before | after |
|---|---|---|
| package name | `@owlette/roost-cli` | `@owlette/cli` |
| primary binary | `roost` | `owlette` |
| env vars | `ROOST_TOKEN`, `ROOST_API_URL`, `ROOST_PROFILE`, `ROOST_ENVIRONMENT` | `OWLETTE_TOKEN`, `OWLETTE_API_URL`, `OWLETTE_PROFILE`, `OWLETTE_ENVIRONMENT` |
| config path | `~/.config/roost/config.toml` | `~/.config/owlette/config.toml` |
| smoke env vars | `ROOST_CLI_SMOKE*` | `OWLETTE_CLI_SMOKE*` |

What did **not** change:
- verb names (`auth login`, `roost push`, `key create`, …)
- flag names + shapes (`--site`, `--to`, `--json`, …)
- exit codes (0 / 1 / 2 / 3 — see [overview](overview.md#exit-codes))
- the underlying http api (every command still hits the same endpoint)

---

## before / after

### binary

```bash
# before
roost --help
roost auth login
roost roost push ./dist --to rst_abc --site site-1

# after
owlette --help
owlette auth login
owlette roost push ./dist --to rst_abc --site site-1
```

### env vars

```bash
# before
export ROOST_TOKEN=owk_live_…
export ROOST_API_URL=https://dev.owlette.app
export ROOST_PROFILE=dev

# after
export OWLETTE_TOKEN=owk_live_…
export OWLETTE_API_URL=https://dev.owlette.app
export OWLETTE_PROFILE=dev
```

### config path

```bash
# before
$ cat ~/.config/roost/config.toml
[profiles.default]
token = "owk_live_…"

# after — same content, new location
$ cat ~/.config/owlette/config.toml
[profiles.default]
token = "owk_live_…"
```

The cli copies the legacy file to the new path on first read. You don't have to move it manually.

---

## what still works (deprecation wrappers)

Through **2026-10-01**, every legacy surface continues to work with a one-time deprecation notice per process:

- **`roost` binary** — installed alongside `owlette` as a thin wrapper. `roost auth login`, `roost roost push`, etc. still run; stderr gets one deprecation line on first invocation.
- **`ROOST_*` env vars** — read as fallbacks when the matching `OWLETTE_*` is unset. Setting both makes the new var win silently (no warning, since the legacy was never read).
- **`~/.config/roost/config.toml`** — copied to `~/.config/owlette/config.toml` on first read of the new path. After the copy, the cli reads the new file going forward; the old file is left in place for safety. If both paths exist, the new one wins — consolidate manually.

---

## upgrade steps (typical machine)

1. **Update the install**:
   ```bash
   npm i -g @owlette/cli
   owlette --version
   ```
   (For local dev from the monorepo, see [overview → installation](overview.md#installation).)

2. **Update shell aliases + ci scripts**:
   ```bash
   # before
   roost auth login
   roost roost push ./dist --to rst_abc

   # after
   owlette auth login
   owlette roost push ./dist --to rst_abc
   ```

3. **Rename env vars** (ci secrets, `.envrc`, shell rc):
   ```bash
   sed -i 's/ROOST_TOKEN/OWLETTE_TOKEN/g; s/ROOST_API_URL/OWLETTE_API_URL/g; s/ROOST_PROFILE/OWLETTE_PROFILE/g; s/ROOST_ENVIRONMENT/OWLETTE_ENVIRONMENT/g' ~/.envrc
   ```

4. **Optionally consolidate config paths** (the cli will do this on first read if you skip):
   ```bash
   mv ~/.config/roost ~/.config/owlette
   ```

5. **Verify**:
   ```bash
   owlette whoami
   ```

---

## ci / scripted environments

If your ci wraps the cli and shells out to it, you have two paths:

- **Pin the new binary** — bump the install step to `@owlette/cli` and rename every `roost ` invocation to `owlette `. Recommended.
- **Stay on the wrapper** — if you can't rename callers immediately, the `roost` binary keeps working until 2026-10-01. The deprecation notice writes to stderr only, so it won't break stdout-parsing pipelines.

In either case, rename your `ROOST_*` secrets to `OWLETTE_*` before the cutoff. The fallback works but a one-time `[owlette] ROOST_TOKEN is deprecated; use OWLETTE_TOKEN instead. legacy env vars will be removed on 2026-10-01.` line lands in stderr on first read.

---

## why the rename

owlette is more than roost — the dashboard manages machines, processes, classic-installer deploys, audit logs, cortex chat, and site membership. The cli now ships verbs for [most of those surfaces](overview.md#noun-matrix), and a `roost`-prefixed binary would be misleading for a tool that does much more than push roosts. Renaming before npm publication prevents a much more painful rename later when external users are pinned across multiple package managers.

---

## removal date

The deprecation wrappers (`bin/roost`, `ROOST_*` env reading, `~/.config/roost/` migration) are scheduled for removal on **2026-10-01**. Track progress through the public API CLI readiness docs and the final cleanup PR.

A scheduled cleanup agent will open the removal pr ~2 weeks before the cutoff so the deletion lands with a clear changelog entry, not as a surprise.

---

## next steps

- [cli overview](overview.md) — install, auth, config, noun matrix
- [reference index](reference/) — every verb + flag in detail
