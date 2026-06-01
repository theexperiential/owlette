# Native Capture Pipeline — ep02 + ep08

**Status:** plan / not started
**Owner:** Dylan
**Date:** 2026-05-31

---

## TL;DR

Recommended: **Plan B (web-parity FfmpegRecorder) for the recorder**, **Plan D's locator + class-name discipline for automation**, **Plan A's bare-metal-no-VM state model with Plan C's per-beat-mkv-then-remux discipline**, and **Plan A's per-beat-author-time-baked dwell constants verified by a runtime ffprobe drift check**. We port `web/e2e/videos/ffmpeg-recorder.ts` to Python verbatim (ddagrab+NVENC primary, gdigrab+libx264 fallback, full bt709/+faststart/GOP-60 args, first-frame stderr gate, PID-targeted taskkill, tmp→final rename, post-capture ffprobe validation including CFR + 60fps assertions), drive the installer wizard and the agent GUI/tray with pywinauto UIA using `class_name`-first locators (TWizardForm, CTkListbox class, ConsoleWindowClass, #32768, #32770), and accept that ep02 ships as **stitched** native+web clips while ep08 ships as a single all-native mp4. We reject the Hyper-V VM (kills ddagrab/NVENC parity inside the guest), reject OBS-websocket (one less moving part, profile-portability + version-pin tax not worth the crash-resilience win once we add the tmp→final rename), and reject the existing gdigrab-ultrafast `ScreenRecorder` (visibly different codec/preset from web, no quality gate). EP08 ships first because it is observation-only (zero state mutation, no UAC, no SmartScreen, no live backend); EP02 follows and accepts a manual UAC click + manual Control-Panel uninstall between takes. Realistic budget is **~78 hours** of focused work (≈ 2 calendar weeks; ep08 shippable end of week 1). All 10 originally-open questions are now answered — see DECISIONS section.

---

## DECISIONS (LOCKED)

All ten original `OPEN QUESTIONS` answered by the owner on 2026-05-31 — these are now load-bearing for the rest of the plan:

| # | Question | Decision | Implication |
|---|---|---|---|
| **D1** | Installer version for ep02 | **v2.12.6** | Already built + installed on the dev box. No `node scripts/sync-versions.js` / `build_installer_full.bat` step needed before Wave 3. EXE location: dev box's local install / build artifacts. |
| **D2** | Backend for ep02 web clips (b07/b08/b09) | **dev.owlette.app + dedicated `tutorial-recording` site** | Drops the Firestore-emulator path for ep02 web takes. Wave 3 adds a one-time "create `tutorial-recording` site (admin role)" task. Pair-flow in b06 completes against the live dev backend. ⚠ implies network determinism risk — see Wave 0 Spike note. |
| **D3** | ep08 demo-process state | **Seed `tutorial-demo-*` sentinels** (Option A) | Wave 2 includes a `seed_demo_processes.py` + `cleanup_demo_processes.py` pair (touchdesigner / resolume / show-player sentinels). Operator's real production config stays off-camera; demo fleet matches script narration. |
| **D4** | Cursor styling on camera | **Accessibility-large cursor** | Wave 0 preflight: set Windows Pointer scheme to a large/high-contrast variant (e.g. "Windows Black (extra large)" or a custom 200% cursor) and restore on teardown. Captured cursor reads from any thumbnail size; matches production-critic argument for visual weight. Applies to ep02 native + ep08 native shots; web pipeline mp4s already shipped with the default cursor — accept the inconsistency. |
| **D5** | EP08 tray icon framing | **Pinned to taskbar** | Wave 2 prep step: operator (or scripted setup) drags the Owlette tray icon out of the overflow flyout and into the always-visible taskbar tray BEFORE the take. Recording targets the pinned location directly; arrow-key menu nav still applies once the menu is open. Reads cleaner on camera than chasing the overflow flyout. |
| **D6** | NLE target for the Wave 0 roundtrip spike | **DaVinci Resolve** (on Windows) | Spike 4 imports the recorder's mp4 + matching beat MP3, places audio under video, exports, verifies first/last-frame alignment and no audio drift > 1 frame across the whole clip. |
| **D7** | EP02 b01 b-roll source | **Web pipeline renders a clean-desktop establishing frame** | Wave 3 adds a tiny web-pipeline scene (`14-ep02-b01-establishing.video.ts` or similar) that produces a controlled clean-desktop frame — no taskbar pinned-app drift, no real notification chrome. Folds into the existing Wave 3 budget (≤ 1h). Operator separately commits to cleaning the actual dev desktop for ep08 native shots where the OS surface is visible behind the tray + GUI. |
| **D8** | Voiceover script front-matter consistency | **Update all 13 scripts** to record actually-rendered model + voice | Wave 4 task (≤ 0.5h): edit `dev/video-tutorials/scripts/NN-slug.md` front-matter to set `voice: RFcSkwoki6Mw26dKUJuB` and `model: eleven_v3` (matching what `voiceover/out/NN-slug/manifest.json` records as actually rendered). Source of truth becomes consistent across script + manifest. Pure doc hygiene; doesn't affect any code. |
| **D9** | Defender exclusion for the recorder's output dir | **Automated** via `Add-MpPreference -ExclusionPath` in a preflight script | Wave 1 task: preflight runs elevated `powershell -Command "Add-MpPreference -ExclusionPath '<out-dir>'"` and checks Tamper Protection status; if Tamper Protection blocks the write, falls back to a clear "operator: add exclusion manually" message + skip-flag (`--skip-defender-config`) so the runner doesn't loop. Documented in WAVE-1.md. |
| **D10** | Buffer hours: optimistic 6h or honest 12h | **12h** (honest framing) | Risk critic's argument across every candidate plan: web pipeline took 4+ iteration rounds + a GPU-state failure to stabilize, and the native side has strictly more unknowns (UAC, pywinauto-DLL-injection, Defender, tray automation). 12h matches that history. Grand total bumps **72h → 78h**. |

---

## CHOSEN ARCHITECTURE

### Composition by layer

| Layer | Choice | Source plan | Why |
|---|---|---|---|
| Recorder | Python port of `FfmpegRecorder` (ddagrab/NVENC primary, gdigrab/libx264 fallback) | **B** | Production critic on B is right: the web pipeline's encoder lifecycle (first-frame stderr gate, q\n flush, PID watchdog, tmp→final rename, ffprobe validation) is the only way to ship MP4s that match web-pipeline clips on the same NLE timeline. A's `subprocess.Popen` + `terminate()` produces silently-corrupt MP4s. C's OBS auto-remux is crash-resilient but introduces profile-portability tax. |
| Encoder args | Web args byte-for-byte, with three native-specific deltas | **B** + production critique fixes | `draw_mouse=1` (real OS cursor is the affordance), `-an` (explicit no-audio, prevents stderr noise), `-fps_mode cfr` (forces CFR — the production critic's correct catch that B and the web pipeline both miss; VFR breaks NLE timecode alignment over long static dwells). |
| Automation | pywinauto UIA backend, `class_name`-first locators with title fallback | **D** | The risk critique on B + production critique on D both agree: title-only locators drift; AutomationId is unreliable for CTk; class_name (`TWizardForm`, `CTk`, `Listbox`, `ConsoleWindowClass`, `#32768`, `#32770`) is stable. DUMP=1 tuning per installer build stays as the escape hatch. |
| Tray icon discovery | Win32 `Shell_NotifyIconGetRect` (Win10 1903+) with arrow-key navigation fallback for the menu | **C**/**D** hybrid | The pragmatist critique on every plan flags tray automation as the single highest implementation risk on Win11. Discovery-by-rect + keyboard-driven menu navigation (no pixel clicks on menu items) is DPI-robust. |
| State setup | Bare-metal, scripted clean-up — **NO Hyper-V VM** | **A** | The risk + pragmatist critiques on D both reject Hyper-V: vGPU kills ddagrab (defeats the whole web-parity argument), DDA/GPU-PV is a half-day side quest, vmconnect can silently rescale. We accept manual Control-Panel uninstall between ep02 takes; ep08 has no teardown. |
| ep02 b06–b09 | **Stitched** — native installer/console portion + Playwright web clips for dashboard/add-page/heartbeat/modal | **D** | The risk critique on every plan that tries to pywinauto-drive Edge is correct: Edge's UIA tree is unstable, anchor-PNG matching is post-hoc detection, and the web pipeline already produces deterministic dashboard clips. Don't fight Chrome from native. |
| Voiceover sync | Constants baked at scene-author time, **plus** a runtime ffprobe drift gate | **A** + pragmatist critique fixes | A's "bake constants from ffprobe at author time" is right (no runtime I/O cost). A's risk that constants drift on VO re-render is real — fix is a one-shot `scripts/sync_durations.py` that re-ffprobes the manifest and rewrites `_durations.py` (checked-in module) when VO is re-rendered, plus a per-run drift assert that compares scene-time dwell vs current MP3 length and fails fast if delta > 100ms. |
| Per-beat capture | One MP4 per beat with `<out>.tmp.mp4` → atomic rename + ffprobe validation | **C**/**B** hybrid | OBS auto-remux's crash-resilience advantage collapses once we do tmp→final rename + assertCaptureValid. Per-beat is the right granularity: retry b04 without re-recording b01-b03. |
| Episode shape | EP08 = single all-native episode; EP02 = native installer/console segment + 4 web clips stitched in NLE | **D** | Honest about the two-physical-machine reality of ep02 (operator's dashboard view in b02/b08/b09 is a different machine from the demo box). EP08 is fully observation-only. |

### Why this composition

- **B's encoder, not OBS:** C's pragmatist critique on OBS is decisive — OBS profiles bake absolute paths (breaks portability), require version-pinning, need first-launch password setup, and conflict with any pre-existing OBS session. Once you add tmp→final rename (cheap, ~30 LoC) the crash-resilience gap B has vs C closes. Stay in pure Python, no GUI app dependency.
- **A's state model, not D's VM:** D's production critique calls out that Hyper-V Gen2 guests don't expose IDXGIOutputDuplication — ddagrab hard-fails inside the VM, capture falls back to libx264, and the entire web-parity claim collapses. The 6-second checkpoint restore is not worth shipping mixed-codec episodes.
- **D's locator discipline, not A's title-only:** A's pragmatist critique flagged that A buffers 3h for "per-beat tuning" but never says how locators resist Inno button-text drift. D's class+title combo locator with per-version override file is the right shape.
- **Stitched ep02, not single-take:** D's risk critique is right that pywinauto-driving Edge for b06/b07 is wishful — Edge's WebView2 content tree exposes Tailwind class names, not stable Names. The web pipeline already nails these beats; reuse it.
- **Production critic's CFR + 60fps assertions:** Both B's and C's production critiques caught that the web pipeline's `assertCaptureValid` checks size/codec/pix_fmt/duration but NOT frame rate or CFR. Native scenes have long static dwells (b06=29s, b04=25.6s) where ddagrab idle-fps drops silently. We add `-fps_mode cfr` to args + an `avg_frame_rate ≈ 60` post-check. This is the single most impactful production-quality upgrade in the plan and we should backport it to the web pipeline too.

---

## REJECTED ALTERNATIVES

### Plan A (minimal extension)

**Offered:** Keep existing `ScreenRecorder` (gdigrab/ultrafast/30fps), add small helpers, write ep08 scene, ~20h.

**Rejected because:**
- Production critic on A: 30fps vs web's 60fps halves cursor-glide motion frames (`smooth_move`'s 24-step 0.35s glide reads as 8 frames vs 17). No `-g/keyint_min/sc_threshold`, no `+faststart`, no bt709 metadata, no temp→rename atomicity, no PID-targeted taskkill, no first-frame readiness gate, no ffprobe validation. Default CRF ~23 + ultrafast preset = visibly blocky output on motion that will not intercut with web clips.
- Pragmatist on A: the 20h budget hides 4h of OBS-by-hand work for ep02 b05/b07-b09 and an un-budgeted demo-VM rebuild.
- Risk on A: no probe gate, no Defender/SmartScreen handling, hardcoded tray coords break on any DPI/taskbar change.

**Kept from A:** the bare-metal state model (manual reset between ep02 takes — D's Hyper-V argument doesn't survive its own risk critique), the existing `recorder.py` pacing helpers (`smooth_move`, `slow_type`, `dump_identifiers`), and the bake-MP3-durations-at-author-time pattern.

### Plan B (web parity, full port)

**Offered:** Direct Python port of FfmpegRecorder + probe + recordScene, byte-for-byte web args, builds v2.12.6 from a prep script, drives Edge via UIA + keyboard chords, ~45h.

**Rejected as-presented because:**
- Pragmatist on B: factually wrong about GUI default state (claims expanded; `owlette_gui.py:65,73` set `details_collapsed=True`). Prep-script triggering `build_installer_full.bat` violates the release workflow (CLAUDE.md mandates version-bump + changelog entry BEFORE build). Tray-process detection by `WINDOW_TITLES` is broken (no tray entry).
- Production on B: missing `-fps_mode cfr` → VFR mp4s drift relative to MP3s. assertCaptureValid 5s tolerance is too loose for native scene drift. Layered-window `highlight_rect` has DWM first-paint flicker.
- Risk on B: NVENC concurrency mitigation only fires at probe time (a Discord screen-share or Teams call mid-run hits 'OpenEncodeSessionEx failed' with no runtime fallback). configure_site console title-matching is brittle on Win11 22H2+ ConPTY (conhost owns the HWND, not python.exe). UAC class name `Credential Dialog Xaml Host` is wrong for Win11 consent.exe.

**Kept from B (the load-bearing pieces):** the FfmpegRecorder port itself (lifecycle, args, probe gate, assertCaptureValid), the per-episode dwell sums, the recordScene orchestrator shape.

### Plan C (OBS-websocket)

**Offered:** OBS hosts the recorder, obsws-python drives it, MKV-then-remux crash resilience, pywinauto for UI, ~37.5h.

**Rejected because:**
- Pragmatist on C: OBS version mismatch (claims 30.x; installed is 32.1.2) — signals the author didn't re-check. `nircmd` claimed available; not on this box. `ffmpeg` claimed on PATH; isn't for a fresh Python process (lives at `C:\ffmpeg\bin`, web pipeline reaches it through a Node wrapper). obsws-python's API described as synchronous; v5 is request/id + event callback threads. OBS profile portability: profiles bake absolute paths and tie to OBS major version (auto-update can silently break import). Pre-existing obs64.exe session must be detected (cannot taskkill — user owns it).
- Production on C: `keyint_min` and scene-cut keyframe disable are NOT in the OBS profile spec by default. NVENC psycho-visual tuning + look-ahead are ON in OBS defaults but OFF in web pipeline's `-tune hq` — produces measurably different bitstream from the same nominal CQP. Color-range matrix tag may be written but pixel-range conversion may not happen (OBS version-dependent), crushing blacks in NLEs that honor the tag.
- Risk on C: PromptOnSecureDesktop registry tamper trips EDR (ASR rule "Block persistence through WMI event subscription") on managed endpoints, and a hard-killed harness leaves the box in a permanently less-secure state. consent.exe class name `Credential Dialog Xaml Host` is wrong. Display Capture WGC drops to BitBlt black-frame on lock screen/screensaver/RDP disconnect.

**Kept from C:** the per-beat output convention, the tmp-then-final pattern conceptually (we use the web's rename pattern, same outcome), and the explicit Focus Assist / notification suppression precondition step.

### Plan D (pure pywinauto + rich Hyper-V fixtures)

**Offered:** Hyper-V VM with 4 named checkpoints, Tier-2 agent-state seeder, Tier-3 fixture flag in configure_site.py for deterministic phrase, ~35.5h.

**Rejected because:**
- Pragmatist on D: Hyper-V VHDX premise is the single biggest failure — vmms not running on this box, host has Parsec Virtual Display Adapter + RTX 2080 Ti, enabling Hyper-V conflicts with WSL2's Hyper-V platform usage, GPU-PV/DDA needs RTX hardware partitioning, vmconnect can rescale. The 4h provision estimate is 1-2 days realistically.
- Production on D: ddagrab inside Hyper-V Gen2 guest hard-fails on default vGPU — falls back to libx264 even with the args ported, defeating the entire bit-format-parity claim. The "Tier-3 fixture flag in configure_site.py" is a guardrailed-file change (`agent/src/configure_site.py`) for tutorial infrastructure that CLAUDE.md explicitly warns against.
- Risk on D: SmartScreen reputation modal on fresh installer EXE not addressed. CTkListbox rows are canvas-painted (not addressable as UIA child elements) — D's b04 "move_click the first row" assumption is wrong. Hyper-V Restore-VMCheckpoint resets network, triggers ConnectionManager circuit breaker, agent's tray "firebase: connected" label flickers on camera. Secure-desktop cursor pre-position is physically impossible (different desktop than user's session).

**Kept from D:** the class_name-first locator discipline, the `class_name='TWizardForm'` + `class_name='ConsoleWindowClass'` + `class_name='#32768'` + `class_name='#32770'` identification list, the keyboard-navigation-not-pixel-click rule for menus, the per-version `wizard-buttons-v{VERSION}.json` override file pattern.

---

## EP02 IMPLEMENTATION

**Capture model:** ep02 ships as **5 stitched clips** in the NLE: one native MP4 covering beats b03-b06 (installer + console), and four Playwright-driven web clips for b01 (or as static B-roll), b02 (dashboard download), b07 (add-page authorize), b08+b09 (machine appears + add modal). The native segment is captured against installer EXE on disk (target v2.12.5 — already built; do NOT auto-build 2.12.6 from a prep script).

**Pre-flight (NOT recorded):** `python scripts/preflight_ep02.py`
- assert OwletteService DOES NOT exist (`sc query OwletteService` returns 1060). If it does, fail loud with operator instructions ("uninstall via Control Panel + reboot + rmdir C:\ProgramData\Owlette"). No auto-uninstall.
- assert `C:\ProgramData\Owlette\` does not exist.
- assert `agent\build\installer_output\Owlette-Installer-v2.12.5.exe` exists.
- assert Defender exclusions in place for `dev\video-tutorials\capture-native\.output\` (the operator must apply these once with `Add-MpPreference`; preflight just verifies).
- assert single primary monitor at 1920×1080 @ 100% DPI.
- assert Focus Assist enabled (Quiet Hours).
- assert no `ffmpeg.exe` or `obs64.exe` orphans holding NVENC.
- copy installer EXE to operator desktop, swap wallpaper to plain dark (save prior path), hide taskbar via `ShowWindow(Shell_TrayWnd, SW_HIDE)` (restore in finally).
- pre-warm Edge cold-start (open + close once off-camera) so b06's browser launch is deterministic — accepted as a documented trade vs cold-state framing.

| Beat | VO (s) | Window / class | pywinauto action | Dwell budget |
|---|---|---|---|---|
| **b01** | 13.79 | Web/static | NOT native — captured via Playwright as static desktop frame OR shot once by hand as cold-open B-roll. | n/a (web) |
| **b02** | 18.21 | Web | NOT native — Playwright clip `02-b02-dashboard-download.video.ts` against seeded emulator. | n/a (web) |
| **b03** | 14.76 | UAC (consent.exe) | Recorder starts. `Application(backend='uia').start(installer_path)` — UAC fires. **Operator clicks Yes by hand** (secure desktop is undriveable). `wait_window(class_name='TWizardForm', timeout=90)` — 90s tolerates SmartScreen if it appears. | 14.76s + UAC-click variance absorbed into b04 budget |
| **b04** | 16.27 | Inno wizard (`class_name='TWizardForm'`) | `find_control(wizard, class_name='TNewButton', title_re=r'(&?Next|Install)')` — class+title combo. Per-build override at `capture-native/fixtures/wizard-buttons-v2.12.5.json`. DisableWelcomePage=yes (per .iss:99) so: Next → Next → Install (verify exact sequence via DUMP=1). Recorder holds through real progress bar. Lower-third overlay added in NLE. | 16.27s |
| **b05** | 15.07 | python.exe console (`class_name='ConsoleWindowClass'`) | Inno's ssPostInstall blocks on configure_site.py with `ewWaitUntilTerminated`. Solve by **threading the wizard click of Install**: spawn a worker thread that calls `click_button('Install')` and don't wait for return; main thread polls for console window appearance. Console identification via process-tree walk (children of installer PID, find `ConsoleWindowClass`) — NOT title regex. UIA `window_text()` scrapes the printed pair phrase. Real phrase, not a fixture — voiceover says "three simple words" generically; the script's `silver-compass-drift` is illustrative. | 15.07s |
| **b06** | 29.07 | Console + browser launch | Focus console (`SetForegroundWindow`), `send_keys('y{ENTER}')`. configure_site.py calls `os.startfile(pairing_url)` → Edge opens. `wait_window(title_re=r'.*owlette.*add.*', timeout=20)`. **No Edge driving in this beat** — pure observation of the browser-open animation. | 29.07s |
| **b07** | 17.01 | Web | NOT native — Playwright clip `02-b07-add-page.video.ts` against seeded emulator, dropdown → "main gallery" → Authorize. | n/a (web) |
| **b08** | 20.61 | Web | NOT native — Playwright clip `02-b08-machine-appears.video.ts` with emulator state flipping machine online at known timestamp. | n/a (web) |
| **b09** | 22.60 | Web | NOT native — Playwright clip `02-b09-add-modal.video.ts` reusing existing dashboard fixtures. | n/a (web) |

**Sum of native beats:** b03 (14.76) + b04 (16.27) + b05 (15.07) + b06 (29.07) = **75.17s** plus pre-roll/post-roll + UAC-click slack. `assertCaptureValid(expected_duration_s=75.17, tolerance_s=20)` — wide tolerance because UAC click + installer progress are operator-paced.

**Cleanup:** finally-block restores wallpaper, shows taskbar, cleans `.tmp.mp4` if recorder did not complete. Operator manually runs Control-Panel uninstall + `rmdir C:\ProgramData\Owlette` between takes (documented in README as ep02's hard reset cost).

---

## EP08 IMPLEMENTATION

**Capture model:** Single all-native MP4 covering b01-b06. Recorded against the live dev-machine agent (paired, running, ≥2 demo processes configured). Zero state mutations — every right-click followed by ESC, no clicks on `leave site`, no clicks on `delete process`.

**Pre-flight (NOT recorded):** `python scripts/preflight_ep08.py`
- assert OwletteService Running (`Get-Service OwletteService`).
- assert tray pythonw.exe alive — detect via psutil cmdline contains `owlette_tray.py` (NOT by WINDOW_TITLES — there's no tray title entry).
- assert paired: `config.json.firebase.site_id` non-empty AND `.tokens.enc` exists.
- assert ≥1 process configured in `config.json.processes[]`. If <2, harness opens GUI and seeds two demo processes with sentinel name prefix `tutorial-demo-*` (one launch_mode=Scheduled for b04 read-only label demo, one Always On). Seeding is a separate non-recorded scene. Post-recording cleanup removes them.
- write `config['gui']['details_collapsed'] = False` and `save_config(config)` so GUI opens expanded at 950×450 (fixes B's pragmatist-flagged bug; the alternative — click the toggle in-scene — captures the expand animation which is off-brand).
- close any pre-existing `owlette configuration` window (by HWND) to avoid `ElementAmbiguousError`.
- assert Defender exclusion + Focus Assist + 100% DPI + 1920×1080 (same as ep02 preflight).
- write `HKCU\Control Panel\NotificationArea\PromotedIcons\tec.owlette.tray = 1` only if the script's b01 voiceover read calls for a pinned icon. **Decision:** leave icon in overflow (matches voiceover "sometimes under the little overflow arrow"). No registry write.
- park cursor at (1700, 1050) near tray for b01 entry.

| Beat | VO (s) | Window / class | pywinauto action | Dwell budget |
|---|---|---|---|---|
| **b01** | 17.87 | Taskbar (`Shell_TrayWnd`) + overflow flyout (`NotifyIconOverflowWindow`) | Recorder starts. `smooth_move(steps=60, total_s=1.0)` from park to taskbar overflow chevron rect (resolved via `FindWindow('Shell_TrayWnd')` → child enumeration). Click chevron → flyout appears. `Shell_NotifyIconGetRect` (Win10 1903+, ctypes shell32) resolves owlette icon rect. Cursor `smooth_move` to icon — hover triggers multi-line tooltip from `owlette_tray.py`. | 17.87s |
| **b02** | 25.39 | Tray popup menu (`class_name='#32768'`) | `mouse.right_click_input(coords=icon_rect_center)`. `wait_window(class_name='#32768', timeout=3)`. Menu holds open. Verify 4 header items + 4 actions via UIA enumeration during DUMP=1 tuning, lock results into `tray-menu-locators.json`. **No clicks** — VO narrates over static menu. End-of-beat: `send_keys('{ESC}')` to close cleanly OR `smooth_move` to "open owlette" + `{ENTER}` to hand off into b03. | 25.39s |
| **b03** | 16.35 | GUI (`title='owlette configuration'`, `class_name='CTk'`) | `wait_window(title='owlette configuration', timeout=15)`. Preflight set `details_collapsed=False` so window opens at 950×450 expanded. `find_control(gui, class_name='Listbox')` (CTkListbox wraps tk Listbox). `smooth_move` cursor over process_list, then hover the `＋` new_button. No click. | 16.35s |
| **b04** | 25.63 | GUI right-pane details | **Row selection is by keyboard, not pixel click** (CTkListbox rows are canvas-painted — D's risk critique). `process_list.set_focus()` + `send_keys('{HOME}')` to select first row (the `tutorial-demo-Scheduled` process so b04's read-only `schedule_info_label` reads "configure via web"). Right-pane populates. `smooth_move` cursor down the labeled entries (launch_mode_menu, exe_path_entry + Browse, file_path_entry, cwd_entry, time_delay_entry, priority_menu, time_to_init_entry, visibility_menu, relaunch_attempts_entry, schedule_info_label) at ~2.3s per element. | 25.63s |
| **b05** | 12.67 | Process row right-click menu (Tk popup) | `process_list.click_input(button='right', coords=(20, 20))` for first-row right-click. Menu pops. `smooth_move` hover down items (restart process / kill process / move up / move down / delete). Dismiss via `PostMessage(menu_hwnd, WM_CLOSE)` (deterministic — D's risk critic's correct catch about Tk ESC binding unreliability). | 12.67s |
| **b06** | 28.45 | Footer frame (`owlette_gui.py:300-345`) | `smooth_move` across footer_frame children: `firebase_status_label` ("connected") → `footer_site_label` → `footer_machine_label` → `site_button` (reads "leave site"). **NO click on site_button.** Then `move_click` overflow_button `···` → opens overrideredirect CTkToplevel with config/logs items → `smooth_move` over items → `PostMessage WM_CLOSE`. | 28.45s |

**Sum of beats:** 126.36s + 150ms pre-roll + 150ms post-roll + intra-beat transitions ≈ **128s**. `assertCaptureValid(expected_duration_s=128, tolerance_s=3)` — tight because no operator-paced waits.

**Cleanup:** finally-block closes GUI (`PostMessage WM_CLOSE` to `owlette configuration`), removes `tutorial-demo-*` sentinel processes from config.json, restarts service to apply.

---

## FILE LAYOUT

All paths absolute under `c:\Users\admin\Documents\Git\Owlette\dev\video-tutorials\capture-native\`.

### New files

```
capture-native/
├── recorder.py                         (REWRITTEN — port FfmpegRecorder, delete ScreenRecorder)
├── native_driver.py                    (NEW — pywinauto wrappers: attach_installer, attach_tray, attach_gui, etc.)
├── probe_capture.py                    (NEW — 3-stage gate port of web/scripts/probe-capture.mjs)
├── runner.py                           (NEW — orchestrator: elevated re-launch, scene dispatcher, finally cleanup)
├── voiceover_sync.py                   (NEW — narrate(beat_id) reads constants + runtime drift check)
├── _durations.py                       (NEW, generated — checked-in MP3 duration constants)
├── requirements.txt                    (UPDATED — add pywin32>=306, psutil>=5.9; pywinauto already pinned)
├── README.md                           (REWRITTEN — remove OBS-by-hand recommendation, document new flow)
│
├── scenes/
│   ├── ep02_install_and_pair.py        (NEW — b03+b04+b05+b06 native segment)
│   └── ep08_tray_and_gui.py            (NEW — all 6 beats)
│
├── scripts/
│   ├── preflight_ep02.py               (NEW — service-absent / EXE-present / DPI / Defender checks)
│   ├── preflight_ep08.py               (NEW — service-running / paired / processes / GUI state checks)
│   ├── cleanup_ep08.py                 (NEW — remove tutorial-demo-* sentinel processes)
│   ├── sync_durations.py               (NEW — ffprobe MP3s, regenerate _durations.py)
│   └── seed_ep08_processes.py          (NEW — open GUI, seed two sentinel demo processes)
│
├── fixtures/
│   ├── wizard-buttons-v2.12.5.json     (NEW — DUMP=1 output, button title overrides per installer version)
│   └── tray-menu-locators.json         (NEW — UIA enumeration of pystray menu items)
│
└── .output/
    ├── videos/                         (mp4 outputs, .tmp.mp4 stragglers cleaned by runner)
    └── run-<ts>/                       (per-run probe.json, state.json, recorder-stderr.log)
```

### Reused from existing scaffold (do NOT rewrite)

- `recorder.py:beat(seconds, label)` — already the Python `narrate()` equivalent; keep wrapping it under `voiceover_sync.beat(beat_id)`.
- `recorder.py:smooth_move`, `move_click`, `slow_type`, `dump_identifiers`, `_cursor_pos` — keep as-is.
- The DUMP=1 environment-variable convention from `install_and_pair.py:87`.

### Reused from web pipeline (do NOT duplicate logic, mirror behavior)

- `web/e2e/videos/ffmpeg-recorder.ts` — the lifecycle reference. Port semantics, not source.
- `web/scripts/probe-capture.mjs` — same exit codes 0/1/2, same 3-stage gate.
- `web/e2e/videos/video-helpers.ts:recordScene` — orchestrator shape (newContext → measure → start → pre-roll → scene → post-roll → stop in finally → validate).
- The voiceover deck under `dev/video-tutorials/voiceover/out/02-install-and-pair/` and `08-agent-tray-and-gui/` — consumed verbatim, no re-render.
- The four Playwright ep02 web clips (NEW): `web/e2e/videos/02-b02-dashboard-download.video.ts`, `02-b07-add-page.video.ts`, `02-b08-machine-appears.video.ts`, `02-b09-add-modal.video.ts` — follow existing patterns under `web/e2e/videos/`.

---

## DEPENDENCIES

### Pip (`capture-native/requirements.txt`)

```
pywinauto>=0.6.9        # already pinned
pywin32>=306            # NEW — win32gui.FindWindow, Shell_NotifyIconGetRect, SetForegroundWindow
psutil>=5.9             # NEW — process-tree walk for configure_site.py console discovery, NVENC orphan detection
```

No other pip deps. No Pillow (no template matching — we don't drive Edge from native). No obsws-python (no OBS). No mss/PIL.

### System-level (verified present on dev box)

- **ffmpeg** at `C:\ffmpeg\bin\ffmpeg.exe` — but NOT on the default Python process PATH. Runner explicitly resolves via `shutil.which('ffmpeg')` first, then falls back to `C:\ffmpeg\bin\ffmpeg.exe`, then `C:\Program Files\ffmpeg\bin\ffmpeg.exe`. Fail loud if neither.
- **ffprobe** alongside ffmpeg — same resolution chain.
- **NVENC-capable NVIDIA GPU** — RTX 2080 Ti confirmed. probe_capture.py checks via synthetic encode.
- **Python 3.9.13** — confirmed.
- **Windows 11 22H2+** with default consent.exe UAC handler.

### Operator one-time setup (NOT pip, NOT automated)

- `Add-MpPreference -ExclusionPath "C:\Users\admin\Documents\Git\Owlette\dev\video-tutorials\capture-native\.output"` (run elevated, once)
- `Add-MpPreference -ExclusionPath "C:\ffmpeg\bin\ffmpeg.exe"` (defender vs growing mp4 throttling)
- Enable Focus Assist via Quick Action toggle before each session.
- Confirm 100% display scaling AND single primary monitor at 1920×1080.

### Explicitly NOT dependencies

- ❌ Hyper-V / VHDX / DDA — rejected.
- ❌ OBS Studio / obs-websocket / obsws-python — rejected.
- ❌ nircmd.exe — replaced by direct pywin32 `ShowWindow` calls.
- ❌ Pillow / template matching — Edge not driven from native.

---

## WORK BREAKDOWN

Realistic estimates with buffer for the failure modes the risk critics flagged. Wave 0 spikes go first and gate the rest.

### Wave 0 — De-risking spikes (must pass before Wave 1)

| Task | Hours |
|---|---|
| Bootstrap venv at `capture-native/.venv`; install requirements.txt; verify pywinauto + pywin32 + psutil import. | 0.5 |
| Spike 1: DUMP=1 against current v2.12.5 installer wizard — confirm `TWizardForm` class, enumerate `TNewButton` children, lock button-title overrides into `wizard-buttons-v2.12.5.json`. | 2 |
| Spike 2: DUMP=1 against running owlette_gui.py — confirm `CTk` root class, `Listbox` child for CTkListbox, CTkMessagebox UIA exposure on this Win11 build, footer widget class names. | 2 |
| Spike 3: Tray-icon-on-Win11 enumeration spike — verify `Shell_NotifyIconGetRect` works for owlette icon, lock notification-area path. If fails, fall back to documented `Shell_TrayWnd → TrayNotifyWnd → NotifyIconOverflowWindow` recipe with explicit AutomationIds for this Win11 build. | 3 |
| Spike 4: Synthetic 5s ddagrab capture on bare metal (NOT a VM) to confirm NVENC works on RTX 2080 Ti and ffmpeg args produce a valid 1920×1080 60fps CFR h264 mp4. | 1.5 |
| **Wave 0 total** | **9** |

### Wave 1 — Recorder + probe + helpers

| Task | Hours |
|---|---|
| Port `FfmpegRecorder` TS → Python: Popen + threaded stderr drainer + first-frame regex (`r'frame=\s*[1-9]\d*'`) + 8s start timeout + q\n flush + 10s watchdog + `taskkill /F /T /PID <pid>` (PID-only). `__enter__/__exit__`, `signal.SIGINT/SIGTERM` + `atexit` hooks. tmp→final `os.replace` on clean exit. | 5 |
| Implement `buildPrimaryFfmpegArgs` / `buildFallbackFfmpegArgs` with native deltas: `draw_mouse=1`, `-an`, `-fps_mode cfr`. Verify args match `ffmpeg-recorder.ts:234-278` line-for-line otherwise. | 1 |
| Port `assertCaptureValid` + ADD frame-rate gate: assert `avg_frame_rate` within ±2 of 60.0 AND `avg_frame_rate == r_frame_rate` (CFR check). Tighten duration tolerance to 3s for fixed scenes, 20s for ep02 (UAC variance). | 1.5 |
| Write `probe_capture.py` — 3-stage gate (deps + synthetic NVENC + real ddagrab) with exit codes 0/1/2. Add native checks: pywinauto importable + Defender exclusion present + DPI=96 via `GetDpiForSystem` + 1920×1080 primary monitor + no orphan ffmpeg/obs64 PIDs. | 3 |
| Build `native_driver.py` — `attach_installer / attach_tray_icon / attach_gui / find_ctk_modal / find_control` (UIA + class_name + title fallback chain with DUMP=1 hint on miss). Reuse existing `smooth_move`/`slow_type` from `recorder.py`. | 4 |
| Build `voiceover_sync.py` — load constants from `_durations.py`, runtime ffprobe drift check (fail if delta > 100ms vs constant), `beat(beat_id, callback=None)` that runs callback then sleeps the remaining time. | 2 |
| Build `scripts/sync_durations.py` — ffprobe every MP3 in `voiceover/out/02-*` and `voiceover/out/08-*`, write `_durations.py` constants module. Run once at scene-author time, re-run whenever VO is re-rendered. | 1 |
| **Wave 1 total** | **17.5** |

### Wave 2 — EP08 first (lower-risk, observation-only)

| Task | Hours |
|---|---|
| Write `scripts/preflight_ep08.py` — all preconditions including `details_collapsed=False` write, sentinel-process seeding, pre-existing GUI kill. | 3 |
| Write `scripts/seed_ep08_processes.py` — open GUI, drive `＋ new_button`, type `tutorial-demo-Scheduled` and `tutorial-demo-AlwaysOn` entries, save. | 2 |
| Write `scripts/cleanup_ep08.py` — remove `tutorial-demo-*` from config.json, restart service. | 1 |
| Write `scenes/ep08_tray_and_gui.py` — 6 beats. Tray icon discovery (per Wave 0 Spike 3 result), pystray menu hold + `{ESC}` close, GUI driving via `class_name='CTk'`, keyboard-row-selection for CTkListbox (not pixel click), `PostMessage WM_CLOSE` for menu dismissal. | 5 |
| End-to-end ep08 dry-run: capture all 6 beats, ffprobe-validate, eyeball against VO MP3s. Iterate on locators. | 4 |
| **Wave 2 total** | **15** |

### Wave 3 — EP02 native segment + web clips

| Task | Hours |
|---|---|
| Write `scripts/preflight_ep02.py` — service-absent / ProgramData-absent / EXE-present / Defender-exclusion / DPI / SmartScreen-trust checks. Wallpaper swap + taskbar hide with restore in finally. | 3 |
| Write `scenes/ep02_install_and_pair.py` — b03+b04+b05+b06 native segment. Includes the threaded-wizard-Install pattern (don't block on `click_button('Install')`, poll for `ConsoleWindowClass`). Process-tree walk for console discovery via psutil. | 6 |
| Write 4 Playwright web clips: `02-b02-dashboard-download.video.ts`, `02-b07-add-page.video.ts`, `02-b08-machine-appears.video.ts`, `02-b09-add-modal.video.ts`. Reuse existing `recordScene` + emulator fixtures. | 4 |
| End-to-end ep02 dry-run: clean machine + capture native segment + capture web clips. First-take success ratio is ~30% — budget for 2-3 takes incl. manual uninstall between. | 5 |
| **Wave 3 total** | **18** |

### Wave 4 — Docs, polish, edge cases

| Task | Hours |
|---|---|
| Rewrite `capture-native/README.md` — remove OBS-by-hand recommendation, document elevation requirement, document UAC manual-click in b03, document operator one-time Defender exclusions, document Focus Assist precondition, troubleshooting section (NVENC busy, DPI mismatch, CTk UIA gaps, console process-tree walk fails, SmartScreen modal appears). | 3 |
| Wire `runner.py` orchestrator: elevated re-launch via `ShellExecuteW('runas', ...)`, scene dispatcher, run artifact collection under `.output/run-<ts>/`, finally-block cleanup. | 2 |
| Cursor scheme normalization in preflight: snapshot original cursor scheme, set to Windows default for the recording session, restore on exit. | 1 |
| Add `signal` + `atexit` register for state restoration (wallpaper, taskbar, cursor) so a Ctrl+C doesn't leave the operator with a black wallpaper and hidden taskbar. | 1 |
| **Wave 4 total** | **7** |

### Buffer

| | |
|---|---|
| Inevitable surprises (locator misses, dwell tuning, console-process discovery, ffmpeg hang, manual uninstall cycles) | **6** |

### Grand total

| Wave | Hours |
|---|---|
| Wave 0 (de-risking spikes) | 9 |
| Wave 1 (recorder + helpers) | 17.5 |
| Wave 2 (ep08) | 15 |
| Wave 3 (ep02) | 18 |
| Wave 4 (docs + polish) | 7 |
| Buffer | 12 |
| **Total** | **~78 hours** |

That's ~10 focused days at 8h/day. Calling it "this week" is unrealistic for a single owner; honest framing is **2 calendar weeks** with EP08 shippable by end of week 1. Buffer raised from 6h to 12h (D10) based on the web-pipeline iteration history.

---

## RISKS & MITIGATIONS

| # | Risk | Source | Mitigation |
|---|---|---|---|
| 1 | UAC consent.exe undriveable (secure desktop) | A/B/C/D all flag | Operator clicks Yes by hand in b03. assertCaptureValid for ep02 has 20s duration tolerance to absorb click variance. NOT disabling PromptOnSecureDesktop (C's risk critic correctly identifies the EDR/policy tamper exposure). |
| 2 | Inno button titles drift between installer builds | A/B/D | Class+title combo locator (`class_name='TNewButton'` + `title_re='(&?Next|Install)'`). Per-version override file `wizard-buttons-v2.12.5.json`. DUMP=1 re-tune required for any new installer build. |
| 3 | SmartScreen modal on fresh installer EXE | C/D risk critics | `wait_window(class_name='TWizardForm', timeout=90)` — 90s tolerates SmartScreen pause. Operator dismisses manually if it appears. Preflight runs `Unblock-File <installer.exe>` to clear MOTW. If installer is signed (currently is, per recent SLSA work) reputation should already be built. |
| 4 | NVENC concurrency — orphan ffmpeg/OBS holds GeForce session | B/C/D | Preflight enumerates ffmpeg.exe/obs64.exe via psutil; refuses to record if found (does NOT taskkill them — user may own them). Runtime fallback: wrap `recorder.start()` in try/except catching NVENC stderr errors and re-spawning with fallback args. |
| 5 | gdigrab/ddagrab fps drops silently on idle desktop | B production critic | `-fps_mode cfr` forces CFR. assertCaptureValid checks `avg_frame_rate ≈ 60` AND CFR (`avg_frame_rate == r_frame_rate`). Long static dwells (b04, b06) absorbed by encoder frame duplication, not silent VFR. |
| 6 | Tray icon discovery on Win11 | A/B/C/D | Wave 0 Spike 3 settles the approach before commit. Plan A: `Shell_NotifyIconGetRect`. Plan B: documented Shell_TrayWnd → ToolbarWindow32 enumeration with tooltip match. Plan C: hardcoded coords with pin precondition. We carry whichever survives the spike, with the fallback documented. |
| 7 | CTkListbox rows not addressable as UIA child elements | D risk critic | Keyboard navigation (`{HOME}`, `{DOWN}`) for row selection — not pixel click. Verified during Wave 0 Spike 2. |
| 8 | CTkMessagebox/CTk context menu dismissal unreliable via ESC | D risk critic | `PostMessage(menu_hwnd, WM_CLOSE)` instead of `send_keys('{ESC}')`. Deterministic regardless of Tk binding. |
| 9 | configure_site.py console title non-deterministic on Win11 ConPTY | B risk critic | Process-tree walk via psutil (find ConsoleWindowClass HWND owned by child of installer PID). NOT title regex. |
| 10 | Inno wizard blocks on configure_site.py (ssPostInstall ewWaitUntilTerminated) | D risk critic | Thread the `click_button('Install')` call so main thread polls for console window appearance. Recorder lifecycle stays on main thread. |
| 11 | Windows toast notifications / Focus Assist contamination mid-capture | A/C risk critics | Preflight asserts Focus Assist ON (Quiet Hours). Operator-set. Verified via HKCU registry probe. |
| 12 | Defender real-time scanning throttles growing .mp4 | A/B risk critics | Operator one-time `Add-MpPreference -ExclusionPath` for `.output/` directory. Preflight verifies the exclusion is present. |
| 13 | Edge cold-start variance (b06 dwell budget) | B/C critics | Pre-warm Edge in preflight (open + close once off-camera). Documented trade vs cold-state framing. b06 dwell is 29.07s — comfortable headroom for warm-start. |
| 14 | OS cursor at 60fps stairsteps vs web's anti-aliased synthetic cursor | B production critic | Bump `smooth_move` default to `steps=60, total_s=1.0` for native (vs current `steps=24, total_s=0.35`). |
| 15 | Live dev backend dependency for b06 pairing | B/D risk critics | Preflight does `curl https://dev.owlette.app/api/health` health probe. Cleanup script revokes test machine via DELETE `/api/devices/<id>` using `.claude/.env.local` key (per `feedback_installer_upload.md`). Endpoint existence verified during Wave 3. |
| 16 | Ctrl+C / harness crash leaves wallpaper/taskbar/cursor in modified state | C risk critic | `atexit.register` + `signal.SIGINT/SIGTERM` hooks for state restoration. State snapshots stored in `.output/run-<ts>/state.json` so a subsequent run can restore from a stale crash. |
| 17 | DPI != 100% silently produces soft 1920×1080 captures | B/C/D | Probe asserts `GetDpiForSystem() == 96`. Refuses to capture otherwise. Also asserts single primary monitor at 1920×1080. |
| 18 | NLE compatibility unverified for h264_nvenc/bt709/+faststart | C production critic | Wave 0 Spike 4 includes loading the synthetic mp4 into Resolve (the team's NLE) and verifying frame-accurate scrub + correct color decoding. Lock encoder choice only after this passes. |
| 19 | Dwell constants drift on VO re-render | A pragmatist critic | `_durations.py` is generated by `scripts/sync_durations.py`. Runtime `voiceover_sync.beat()` re-ffprobes current MP3 and asserts within 100ms of the constant. CI doesn't fail (this is a dev-time pipeline) but the assertion fires before recording starts. |
| 20 | Two-physical-machine constraint for ep02 (operator's dashboard view vs demo box) | D pragmatist critic | Explicit decision: ep02 native segment is one physical machine; web clips b02/b07/b08/b09 are captured separately and stitched. NO attempt to record both on one machine. Cursor styling matched between native and web (web pipeline updated to use real OS cursor via the same `draw_mouse=1` Playwright config OR Playwright synthetic cursor is overlaid on native footage in NLE — operator chooses). |

---

## SUCCESS CRITERIA

### Hard pass/fail signals

- ✅ `probe_capture.py` exits 0 on the dev box (NVENC + ddagrab + gdigrab + 100% DPI + 1920×1080 + no orphan ffmpeg + Defender exclusion + pywinauto importable).
- ✅ EP08 produces ONE MP4 at `capture-native/.output/videos/08-agent-tray-and-gui.mp4` with:
  - ffprobe reports width=1920, height=1080, codec=h264, pix_fmt=yuv420p, avg_frame_rate within ±2 of 60, CFR (avg_frame_rate == r_frame_rate), duration within ±3s of 128s.
  - All 6 beats visible end-to-end: tray icon discovery, right-click menu shows the 4 status + 4 action lines, GUI opens expanded, process details form populates, right-click context menu surfaces 5 items, footer reads "leave site".
  - No clicks on `leave site`, no clicks on `delete process` — sentinel-process state unchanged after recording.
- ✅ EP02 native segment produces ONE MP4 at `capture-native/.output/videos/02-install-and-pair-native.mp4` with:
  - ffprobe reports same format constraints as ep08, duration within ±20s of 75s.
  - b03 UAC dialog visible (operator-clicked Yes), b04 wizard progress visible, b05 pair phrase legible, b06 browser open + on /add visible.
- ✅ EP02 four Playwright web clips produced at `web/e2e/videos/.output/02-b02-*.mp4` etc., each ffprobe-valid.
- ✅ All 5 ep02 clips (1 native + 4 web) + ep08 single clip drop into a Resolve timeline with no transcode prompt and scrub frame-accurately.
- ✅ Voiceover drops underneath each clip in the NLE and audio finishes within ±100ms of video end on each beat.

### Soft signals (nice to hit, not blocking)

- Wave 0 spikes complete in <9 hours (confirms locator assumptions match reality).
- EP08 first take produces a usable mp4 (no re-runs needed for state setup or locator misses).
- EP02 first end-to-end attempt produces at least the b03+b04 portion cleanly (b05/b06 may need a second take).
- README accurately describes the new pipeline + troubleshooting for the operator.

### Out of scope for "done"

- ❌ Hyper-V VM provisioning (rejected).
- ❌ OBS integration (rejected).
- ❌ Other episodes (ep01, ep03–ep07, ep09–ep13) — separate work; this plan ships ep02 + ep08 only.
- ❌ NLE assembly itself — operator does the cuts.
- ❌ Final color grade / lower-third overlays — NLE-only.
- ❌ Audio mixing — VO already rendered, dropped underneath in NLE.

---

## OPEN QUESTIONS

**All 10 resolved on 2026-05-31** — see the **DECISIONS (LOCKED)** section near the top. Wave 0 is unblocked; first executable step is the spike list in the Work Breakdown.
