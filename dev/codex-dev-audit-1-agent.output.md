# Agent dev-gap audit

## Summary
- 1 TODO/HACK marker (0 blocking, 1 nice-to-have, 0 stale)
- 12 dead/unreferenced functions
- 5 v1 paths to delete
- 5 half-wired pattern groups
- 8 MockService drift items
- 1 sync stack issue
- 29 untested modules

## Blocking-for-v3 items
- [agent/src/firebase_client.py:1412] + [agent/src/sync_commands.py:314] - `cancel_sync` is registered, but it is queued on the same single slow-command worker as long-running `sync_pull`; while `sync_pull` is downloading/assembling, the cancel handler cannot run to set `_inflight_cancels[dist_id]` - blocking because the roost v2 cancellation contract is not actually reachable during an active sync - add `cancel_sync` to a fast/special command lane or make `sync_pull` spawn a background worker and return immediately.
- [agent/src/owlette_runner.py:174] vs [agent/src/owlette_service.py:279] - `MockService.__init__` is missing auto-restore state attributes (`_drift_pending_key`, `_last_auto_restore_success_key`) and other service attrs listed below - blocking because production NSSM runs through `MockService` and this class of drift is a known crash landmine - mirror the missing attrs and add a parity test.

## Half-wired patterns
- [agent/src/cortex_tools.py:178] - `get_gpu_processes` is decorated as a Tier 1 Cortex tool but is omitted from `_make_tier1_tools()`'s returned list at [agent/src/cortex_tools.py:232], so it is unreachable. Proposed fix: add it to the return list and add a tool-count/name regression test.
- [agent/src/owlette_gui.py:1362] - `_bind_right_click_to_list()` is a pass-only no-op and has no callers. Proposed fix: delete it.
- [agent/src/sync_commands.py:540] - `_make_chunk_url_provider()` intentionally returns a provider that raises `NotImplementedError` when `service.firebase_client` is absent; test coverage confirms this is a clear local-only-mode error, not a missing implementation.
- Dead/unreferenced functions from static name/attribute reference scan:
  - [agent/src/auth_manager.py:554] - `AuthManager.clear_credentials()` has no callers.
  - [agent/src/connection_manager.py:352] - `ConnectionManager.is_operational` has no callers.
  - [agent/src/connection_manager.py:923] - `ConnectionManager.unregister_thread()` has no callers.
  - [agent/src/owlette_gui.py:984] - `OwletteConfigApp.add_process()` is an old duplicate of the current `new_process` / `update_selected_process` flow.
  - [agent/src/owlette_gui.py:1362] - `OwletteConfigApp._bind_right_click_to_list()` has no callers and only contains `pass`.
  - [agent/src/owlette_service.py:1797] - `OwletteService.get_session_output_path()` has no callers.
  - [agent/src/owlette_tray.py:78] - `is_windows_dark_theme()` has no callers.
  - [agent/src/owlette_tray.py:592] - `leave_site()` has no callers; GUI has its own leave-site implementation.
  - [agent/src/pair_phrases.py:272] - `normalize_pair_phrase()` has no callers; `pair_phrases.py` itself is not imported by agent source.
  - [agent/src/project_utils.py:166] - `cancel_distribution()` has no callers; the legacy cancel branch does direct temp cleanup instead.
  - [agent/src/secure_storage.py:342] - `SecureStorage.is_configured()` has no callers.
  - [agent/src/sentry_utils.py:79] - `enrich_context()` has no callers.
- Unused imports without callers: [agent/src/command_router.py:24] `Optional`; [agent/src/CTkMessagebox.py:7] `shared_utils`; [agent/src/destination_allowlist.py:35] `stat`; [agent/src/firebase_client.py:32] `datetime`; [agent/src/firestore_rest_client.py:40] `time`; [agent/src/firestore_rest_client.py:45] `quote`; [agent/src/mcp_tools.py:11] `hashlib`; [agent/src/nvapi_display.py:23] `c_char`, `c_float`, `c_uint`; [agent/src/owlette_gui.py:9] `signal`; [agent/src/owlette_scout.py:2] `json`, [agent/src/owlette_scout.py:3] `os`; [agent/src/owlette_service.py:41] `tempfile`, [agent/src/owlette_service.py:54] `STATUS_OK`; [agent/src/owlette_tray.py:29] `win32service`; [agent/src/project_utils.py:10] `shutil`, [agent/src/project_utils.py:12] `subprocess`; [agent/src/screenshot_capture.py:27] `io`; [agent/src/secure_storage.py:28] `shared_utils`; [agent/src/shared_utils.py:283] `NVMLError`; [agent/src/sync_assembler.py:40] `List`; [agent/src/sync_scrub.py:37] `Iterable`, [agent/src/sync_scrub.py:39] `Version`; [agent/src/sync_version.py:29] `hashlib`, [agent/src/sync_version.py:36] `Any`, `Iterable`.

## v1 paths (post-cutover deletion list)
- [agent/src/owlette_service.py:14] - `import project_utils` exists only for legacy single-URL ZIP distribution.
- [agent/src/owlette_service.py:3601] - `elif cmd_type == 'distribute_project'` handles old one-shot project distribution using `project_url`, `project_name`, optional `extract_path`, `verify_files`, and `distribution_id`.
- [agent/src/owlette_service.py:3675] - `elif cmd_type == 'cancel_distribution'` handles old distribution cancellation by deleting the temp ZIP path.
- [agent/src/project_utils.py:1] - whole module is legacy v1 ZIP distribution support: `extract_zip()` [18], `verify_project_files()` [78], `get_temp_project_path()` [115], `cleanup_project_zip()` [145], `cancel_distribution()` [166], `get_default_project_directory()` [197], `download_project()` [212].
- [agent/src/sync_state.py:270] - `extract_root` is optional only for backward compatibility with v1 callers; after v1 deletion, this can be tightened if scrub should require a destination root for all committed rows.

## MockService drift
- Present in `OwletteService.__init__` but missing from `MockService.__init__`:
  - [agent/src/owlette_service.py:242] `hWaitStop`
  - [agent/src/owlette_service.py:247] `_scm_stop_requested`
  - [agent/src/owlette_service.py:279] `_drift_pending_key`
  - [agent/src/owlette_service.py:280] `_last_auto_restore_success_key`
- Present in `MockService.__init__` but missing from `OwletteService.__init__`:
  - [agent/src/owlette_runner.py:157] `config`
  - [agent/src/owlette_runner.py:158] `processes`
  - [agent/src/owlette_runner.py:159] `app_states`
  - [agent/src/owlette_runner.py:167] `_last_scheduled_reboot_time`

## Sync stack
- Wired: `OwletteService.__init__` creates `CommandRouter` and registers roost handlers at [agent/src/owlette_service.py:297] and [agent/src/owlette_service.py:303]; `MockService` mirrors that at [agent/src/owlette_runner.py:188] and [agent/src/owlette_runner.py:190].
- Wired: `handle_firebase_command()` dispatches registered command types before the legacy chain at [agent/src/owlette_service.py:2847].
- Wired: `FirebaseClient._process_command()` sends non-fast commands to the slow worker at [agent/src/firebase_client.py:1412], and `main()` registers `handle_firebase_command` as the Firebase callback at [agent/src/owlette_service.py:6079].
- Wired: `sync_commands.register_handlers()` registers `sync_pull`, `cancel_sync`, and `rollback_to_version` at [agent/src/sync_commands.py:64].
- Wired: `_handle_sync_pull()` reaches `sync_version.fetch_version/diff_versions`, `sync_state.SyncState`, `sync_downloader.download_all`, and `sync_assembler.assemble_all`.
- Issue: `cancel_sync` is reachable only after the slow worker finishes the active `sync_pull`, so it cannot cancel an active long-running distribution. This is the one sync stack dev gap found.

## Test gaps
Modules in `agent/src/` with no corresponding `agent/tests/**/test_<module>.py` file:
- `CTkMessagebox.py`
- `cleanup_commands.py`
- `configure_site.py`
- `cortex_firestore.py`
- `cortex_tools.py`
- `custom_messagebox.py`
- `hardware_profile.py`
- `machine_commands.py`
- `mcp_tools.py`
- `nvapi_display.py`
- `owlette_cortex.py`
- `owlette_gui.py`
- `owlette_runner.py`
- `owlette_scout.py`
- `owlette_service.py`
- `owlette_tray.py`
- `pair_phrases.py`
- `process_launcher.py`
- `project_utils.py`
- `prompt_restart.py`
- `reboot_state.py`
- `registry_utils.py`
- `report_issue.py`
- `secure_storage.py`
- `sentry_utils.py`
- `session_exec.py`
- `session_state.py`
- `start_service.py`
- `watchdog_state.py`

## Top 3 actual DEV items needed before v3.0.0 ships
1. Fix roost cancellation dispatch: make `cancel_sync` able to run concurrently with active `sync_pull`, then add a regression test proving the cancel event is set while a sync is still in progress.
2. Fix `MockService` <-> `OwletteService` parity and add a test that diffs `self.*` assignments in both constructors.
3. Wire or remove `cortex_tools.get_gpu_processes`; it is currently declared as a tool but absent from the exported Tier 1 tool list.
