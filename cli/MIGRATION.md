# migrating from `@owlette/roost-cli` → `@owlette/cli`

The CLI was renamed in v0.2.0. This is a one-page summary of every
breaking surface and how it's softened during the deprecation window.

**Hard deprecation date**: 2026-10-01. After that, the legacy paths
listed below stop working. Plan to migrate before then.

## what changed

| area              | before                         | after                            |
|-------------------|--------------------------------|----------------------------------|
| package           | `@owlette/roost-cli`           | `@owlette/cli`                   |
| primary binary    | `roost`                        | `owlette`                        |
| env vars          | `ROOST_TOKEN`, `ROOST_API_URL`, `ROOST_PROFILE`, `ROOST_ENVIRONMENT` | `OWLETTE_TOKEN`, `OWLETTE_API_URL`, `OWLETTE_PROFILE`, `OWLETTE_ENVIRONMENT` |
| config path       | `~/.config/roost/config.toml`  | `~/.config/owlette/config.toml`  |
| smoke env (tests) | `ROOST_CLI_SMOKE*`             | `OWLETTE_CLI_SMOKE*`             |

Command shapes (`auth login`, `roost push`, `key create`, etc.) and
exit codes did **not** change in this rename. Only the top-level binary
name, env-var prefix, and config-path prefix moved.

## what still works (deprecation wrappers)

Through **2026-10-01**, all of the following continue to work but emit
a one-time deprecation notice per process:

- `roost <verb>` — the `roost` binary is a thin wrapper around
  `owlette`. `roost auth login`, `roost roost push`, etc. still run.
- `ROOST_TOKEN`, `ROOST_API_URL`, `ROOST_PROFILE`, `ROOST_ENVIRONMENT`
  are read as fallbacks when the matching `OWLETTE_*` env is unset.
  Setting `OWLETTE_TOKEN` alongside `ROOST_TOKEN` makes the new var win
  with no warning.
- `~/.config/roost/config.toml` is copied to
  `~/.config/owlette/config.toml` on first read of the new path. After
  the copy, the CLI reads the new file going forward; the old file is
  left in place for safety. If both paths exist, the new one wins —
  consolidate manually.

## upgrade steps (typical machine)

1. Update install: `npm i -g @owlette/cli` (or your package manager
   equivalent — Homebrew/Scoop/winget recipes ship under the new name).
2. Replace shell aliases / CI scripts: `roost ` → `owlette `.
3. Rename env vars in CI secrets / `.envrc` / shell rc:
   `ROOST_TOKEN` → `OWLETTE_TOKEN`, etc.
4. Optionally `mv ~/.config/roost ~/.config/owlette` (the CLI will do
   this on first read if you skip — same effect).
5. Run `owlette auth status` to verify.

## why now

owlette is more than roost — dashboards manage machines, processes,
classic-installer deploys, logs, cortex chat, site membership. None of
those have CLI coverage today, but they will. Renaming before publishing
prevents a much more painful rename later when the CLI has external
users on multiple package managers.

## removal date

The deprecation wrappers (`bin/roost`, `ROOST_*` env reading,
`~/.config/roost/` migration) are scheduled for removal on **2026-10-01**.
Track progress + final removal at
`dev/active/owlette-cli/` and the cleanup-PR routine.
