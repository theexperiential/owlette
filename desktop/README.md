# Owlette Desktop

Tauri 2 desktop shell for Owlette. Vite + React 19 + TypeScript on the frontend,
Rust on the host side, wearing the same design system as the web portal.

This package is **not** an npm workspace of the monorepo root — install and run
its commands from inside `desktop/`.

## Prerequisites

- Node.js 22 (`.nvmrc` at the repo root)
- Rust stable + Cargo (`rustup` installs both; on Windows Cargo lands in
  `%USERPROFILE%\.cargo\bin`, which must be on `PATH`)
- Visual Studio 2022 C++ build tools (MSVC toolchain + Windows SDK)
- WebView2 runtime — preinstalled on Windows 11

## Commands

```bash
cd desktop
npm install

npm run tauri dev      # compile the Rust host + start vite, open the app window
npm run tauri build    # produce an installer in src-tauri/target/release/bundle/

npm run dev            # frontend only, in a browser at :1420 (no Tauri IPC)
npm run build          # typecheck + production frontend bundle into dist/
npm run typecheck      # tsc -b
npm test               # vitest run
npm run test:watch     # vitest
npm run lint           # oxlint
```

The first `tauri dev` compiles ~435 crates and takes several minutes; later runs
are incremental and start in seconds.

## Layout

```
desktop/
├─ index.html            # <html class="dark">, body font-sans antialiased
├─ components.json       # shadcn config (new-york, neutral, cssVariables)
├─ vite.config.ts        # @ alias, tailwind 4 plugin, tauri dev server, vitest
├─ public/               # icon.svg, owlette-eye.svg
├─ src/
│  ├─ globals.css        # design tokens + unlayered interaction rules
│  ├─ assets/fonts/      # self-hosted Geist / Geist Mono (variable woff2)
│  ├─ components/ui/     # 22 shadcn primitives, verbatim from web/
│  ├─ components/landing/OwletteEye.tsx
│  ├─ lib/utils.ts       # cn()
│  ├─ lib/surfaces.ts    # MENU_SURFACE recipe
│  ├─ lib/ipc.ts         # typed wrappers for every host command + event
│  └─ test/              # vitest setup + design-system smoke test
└─ src-tauri/
   ├─ src/paths.rs       # %PROGRAMDATA%\Owlette layout + path scoping
   ├─ src/json_io.rs     # named-mutex + atomic JSON read/write
   ├─ src/watchers.rs    # directory watchers for the three seam files
   ├─ src/service_ctl.rs # OwletteService SCM state / start / stop
   ├─ src/process_ctl.rs # WM_CLOSE-then-terminate with an identity check
   ├─ src/pid_file.rs    # tmp/gui.pid
   ├─ src/commands.rs    # #[tauri::command] adapters (no logic)
   └─ src/lib.rs         # builder, plugins, watcher wiring, exit cleanup
```

## The service seam

The python service and this app share three files under
`%PROGRAMDATA%\Owlette`, and the host reimplements that contract exactly rather
than inventing a new one — both are in the field at once.

| File | Written by | Read for |
| --- | --- | --- |
| `config/config.json` | both | process list, machine settings |
| `tmp/app_states.json` | service | live status per OS pid |
| `tmp/service_status.json` | service | connection + health footer |

Rules the host enforces, all sourced from `agent/src/shared_utils.py`:

- Every read and write takes the named mutex `Global\OwletteJsonFileMutex` with
  a 2 000 ms budget and always releases it, matching `_CrossProcessLock`. On
  timeout it proceeds unlocked and says so in the returned `lock` field.
- **The mutex is unreachable from a non-elevated process on a machine where the
  service is running.** The service creates the object as LocalSystem, and that
  token's default DACL does not give user processes access — measured, both
  `CreateMutex` and `OpenMutex` return `ERROR_ACCESS_DENIED`, and
  `shared_utils._CrossProcessLock` has been silently degrading to unlocked
  access in the legacy GUI for the same reason (it reports `acquired=False`).
  So the lock is best-effort on both sides today and **atomicity is what
  actually protects the files**; writes report `lock: "unavailable"` rather than
  hiding it. Fixing this properly means having the service create the mutex with
  an explicit security descriptor — an agent-side change.
- Writes go to a scratch file in the destination directory and are renamed over
  the target, with `indent=4` formatting and **key order preserved** — the
  `firebase` block must survive a desktop write byte-identical.
- Reads retry three times (100/200 ms) on a locked or half-written file and then
  fail. Python returns `{}` there; we do not, because a UI that writes back an
  empty document would erase the operator's config.
- Frontend paths are resolved inside the data root; `..` and outside paths are
  rejected.
- Because the files are replaced atomically, the watchers are registered on
  `config\` and `tmp\`, not on the files, and coalesce each replace burst into
  one `owlette://file-changed` event.
- `service_status.json` older than 120 s means the service is not writing, no
  matter what the SCM reports (`owlette_tray.read_service_status`); the service
  refreshes it on a 30 s throttle, so anything under two minutes is normal.

`src/lib/ipc.ts` is the only place allowed to call `invoke` — one typed function
per command, plus the event subscriptions.

## Design system

Everything visual is ported from `web/` and **must stay a verbatim copy** where
it is marked as one. `src/components/ui/*` and `src/lib/utils.ts` are byte-for-byte
the files in `web/components/ui/` and `web/lib/utils.ts`; the `@` alias in
`vite.config.ts` and `tsconfig.app.json` exists specifically so those files
compile here with their `@/lib/utils` imports untouched. When a primitive changes
in `web/`, re-copy it rather than editing this copy. (`.oxlintrc.json` turns
`react/only-export-components` off for that directory for the same reason — the
`buttonVariants`/`badgeVariants` co-exports are shadcn's shape, not ours to fix.)

Three of the primitives are hand-customised in `web/` and easy to clobber by
re-running `npx shadcn add`:

- `button.tsx` — `.btn-sweep` in the cva base, **no** `hover:bg-*` on any variant
  (the sweep supplies hover), `link` variant uses `.hl-link`, plus the extra
  `icon-sm` / `icon-lg` sizes.
- `input.tsx` — `aria-invalid:ring-[3px]` unconditionally, not only when focused.
- `sonner.tsx` — Owlette toast palette and lucide icon set.

### globals.css

Ported from `web/app/globals.css`. Tailwind 4 is configured **CSS-first**: there
is no `tailwind.config.*` anywhere in this package, the theme lives in the
`@theme inline` block, and `components.json` carries `"config": ""` to say so.

The rules below `@layer components` — `.hl-link`, `.btn-sweep`, `.form-reveal`,
and the native temporal-input `color-scheme` rules — are **deliberately
unlayered**, so they outrank Tailwind's utilities layer and a stray
`hover:bg-*`/`hover:underline` can't fight them. Their order matters. Don't wrap
them in a layer and don't reorder them.

Blocks dropped during the port because they belong to web-only surfaces:
`.cortex-markdown`, `.machines-grid` / `.site-row-cv` (list virtualisation), and
the `.hero-*` entrance keyframes (plus their now-orphaned
`prefers-reduced-motion` overrides).

### Fonts

The web app gets Geist through `next/font/google`, which generates the
`--font-geist` / `--font-geist-mono` variables. Those variable names are
load-bearing — `@theme inline` maps them to `--font-sans`, `--font-heading` and
`--font-mono`, and ported rules reference `var(--font-geist)` directly.

There is no `next/font` here and a desktop app must not fetch fonts at runtime,
so the two variable-weight woff2 files are vendored in `src/assets/fonts/` and
bound to the same variable names via `@font-face` in `globals.css`. They came
from `geist@1.7.2` (`dist/fonts/geist-sans/Geist-Variable.woff2` and
`dist/fonts/geist-mono/GeistMono-Variable.woff2`), SIL Open Font License 1.1 —
see `src/assets/fonts/LICENSE.txt`. To update, install `geist`, copy the two
files across, and delete the dependency again.

## Tests

`npm test` runs a vitest smoke test over the seams of the port: the `@` alias,
`cn()` + `cva()` + `tailwind-merge`, the `button.tsx` customisations, and the
integrity of `globals.css` (unlayered rules present, font variables bound,
stripped blocks still stripped). It is not a component test suite.

`src/globals.css` is opted into `test.css` in `vite.config.ts` — vitest stubs
CSS imports to an empty string by default, which would silently empty the
`?raw` import those assertions read.

## Window

`src-tauri/tauri.conf.json` sets the window to 1280×800 with a 900×600 minimum,
centred, `theme: "Dark"`, and `backgroundColor: "#020B16"` — the sRGB value of
the dark `--background` token (`oklch(0.145 0.03 250)`), so the native window
paints the app's background instead of white before the webview's first frame.
`dragDropEnabled` is on.
