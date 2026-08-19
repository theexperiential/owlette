# cortex cli provisioning

Cortex drives the Claude Code CLI (`claude.exe`). Since 3.0.0 the agent installer no longer ships it: `build_installer_full.bat` deletes `claude_agent_sdk/_bundled/claude.exe` from the build tree (241.5 MB — about 60% of the old payload) behind a verify-and-fail guard, and `_bundled/` ships as an empty directory.

Agents fetch their own copy on demand instead, pinned by sha256 through one Firestore document. This runbook covers publishing and refreshing that pin.

**Owner surfaces**

| what | where |
| --- | --- |
| provisioning script | `scripts/upload-cortex-cli.mjs` |
| agent-side fetch | `agent/src/cortex_cli_fetch.py` (`ensure_cli`) |
| call site | `agent/src/owlette_cortex.py` → `ClaudeAgentOptions(cli_path=...)` |
| pin document | `installer_metadata/cortex_cli` (public read, service-account write) |
| storage object | `gs://<bucket>/cortex-cli/<version>/claude.exe` |
| machine cache | `C:\ProgramData\Owlette\cache\claude-cli\` |

## when to refresh

Re-run the script when the pinned CLI changes. In practice that means:

- **`claude-agent-sdk` is upgraded** and the new release vendors a different CLI. Check `claude_agent_sdk/_cli_version.py` (`__cli_version__`) before and after the bump — if it moved, the pin is stale.
- **A new environment is stood up** (a fresh Firebase project has no `installer_metadata/cortex_cli`, so `ensure_cli` fails closed and Cortex will not start there).
- **The storage object is lost or the signed download URL is invalidated** (bucket migration, object deletion, key rotation).

Nothing else requires a refresh. Agent version bumps do not — the pin is independent of `agent/VERSION`.

> **Release gate:** a 3.0.0+ installer released into an environment whose `installer_metadata/cortex_cli` is missing or stale leaves Cortex dead on every fresh install. Provision the pin *before* promoting an installer in that environment.

## publishing a new pin

Prerequisites: Node 22, `web/node_modules` installed (the script resolves `firebase-admin` from there), and Firebase admin credentials for the target project — `FIREBASE_PROJECT_ID_{DEV|PROD}` / `FIREBASE_CLIENT_EMAIL_{DEV|PROD}` / `FIREBASE_PRIVATE_KEY_{DEV|PROD}`, falling back to the unsuffixed trio in `web/.env.local`. `web/.env.local`, `.claude/.env.local` and `scripts/.env.local` are auto-loaded.

The source binary is whatever `pip install -r agent/requirements.txt` puts at
`<python>\Lib\site-packages\claude_agent_sdk\_bundled\claude.exe` — publish that exact file, never a separately downloaded CLI, so the pin always matches the SDK the agent runs.

```bash
# 1. dry run — hashes the file, prints the plan, writes nothing
node scripts/upload-cortex-cli.mjs --env=dev \
  --file="C:/ProgramData/Owlette/python/Lib/site-packages/claude_agent_sdk/_bundled/claude.exe" \
  --dry-run

# 2. dev
node scripts/upload-cortex-cli.mjs --env=dev --file="<path to claude.exe>"

# 3. prod (interactive confirmation unless --yes)
node scripts/upload-cortex-cli.mjs --env=prod --file="<path to claude.exe>" --yes
```

Flags: `--version=X.Y.Z` overrides the version (default is parsed from `<file> -v`), `--force` re-uploads over a byte-identical object, `--dry-run` and `--yes` as above.

What it does, mirroring the installer upload flow's three steps:

1. hashes the file once for both sha256 (the pin) and md5 (GCS's integrity field);
2. mints a 15-minute v4 signed **write** URL and streams the binary to it with an explicit `Content-Length`;
3. re-reads the stored object's metadata and fails unless size **and** md5 match the local file, mints the long-lived signed **read** URL (expiry 2030-01-01, same as installer downloads), range-probes it, then writes `installer_metadata/cortex_cli`.

Re-running with an unchanged binary is a no-op upload: the object is detected as byte-identical and only the URL and document are refreshed.

Document shape:

```json
{
  "version": "2.1.121",
  "downloadUrl": "https://storage.googleapis.com/…",
  "sha256": "0a85980a…",
  "size": 253241504,
  "storagePath": "cortex-cli/2.1.121/claude.exe",
  "md5Base64": "cqyDnpzkqOoo0EqA4trpZw==",
  "uploadedAt": 1786594109346,
  "uploadedBy": "scripts/upload-cortex-cli.mjs"
}
```

`version`, `downloadUrl` and `sha256` are the only fields the agent requires; `size` is used for a disk-space guard. A malformed document is treated as *no* document.

### why not `POST /api/installer/upload`

That route hardcodes `agent-installers/versions/{version}/Owlette-Installer-v{version}.exe` and finalizes into `installer_metadata/data/versions/{version}`, optionally moving the `latest` pointer. Pushing `claude.exe` through it would publish a bogus agent-installer "2.1.121" — served by the public `/download` and `/api/installer` endpoints — whose bytes are the Claude CLI. The provisioning script therefore reuses the *mechanism* (signed-URL upload → verify → metadata write) against a dedicated `cortex-cli/` prefix, with the Admin SDK, exactly like the other maintainer scripts in `scripts/`.

## what agents do with it

`cortex_cli_fetch.ensure_cli()` runs once per Cortex start, before `ClaudeAgentOptions` is built, and resolves in this order:

1. **sidecar-verified binary** — `cache/claude-cli/version.json` records the path, sha256 and size of a binary already checksum-verified. Still present, still that size, sha256 still matching the pin → used as-is. No hashing, no transfer.
2. **adopt a matching local binary** — hashing 241.5 MB beats downloading it, so a cached binary whose sidecar was lost, and the SDK's `_bundled/claude.exe`, are checksummed against the pin first. A match is adopted and the sidecar is written to point at it. **Machines upgraded in place from 2.x keep their bundled copy** (the installer copies the python tree over without pruning it), so the fleet upgrade costs no bandwidth at all — only genuinely fresh installs download.
3. **pinned download** — stream `downloadUrl` → `verify_checksum` → atomic `os.replace` into `cache/claude-cli/claude.exe` → sidecar. A checksum rejection deletes the file and retries once.
4. **unverified fallback** — if the pin cannot be satisfied at all, any CLI already on disk is used with a warning (cached binary first, then the bundled copy), so an outage cannot take Cortex offline on a machine that already has a working CLI.
5. **give up cleanly** — `main()` writes `cortexStatus.error` on the machine document and exits without an exception. The service relaunches Cortex every 30 s, so failures are persisted to `cache/claude-cli/fetch_state.json` and gate the next attempt behind an exponential backoff (5 min doubling to 1 h) — a broken fetch never becomes a download loop.

`cli_path` fully short-circuits the SDK's own discovery: `SubprocessCLITransport.connect()` only calls `_find_cli()` when `cli_path` is `None`, so a stray `claude` on `PATH` can never be picked up instead.

**First-enable cost is a 241.5 MB download per fresh-install machine.** It happens the first time Cortex starts on that machine, not at install time, and is skipped entirely on 2.x in-place upgrades.

## verifying a pin

Re-running the script with `--dry-run` prints the local sha256; compare it against `installer_metadata/cortex_cli.sha256` in the Firebase console (or via any admin-credentialled read). A successful non-dry run already re-verifies size + md5 against storage and range-probes the download URL, so a green run *is* the verification.

On a machine, force a re-resolve by deleting `C:\ProgramData\Owlette\cache\claude-cli\version.json` and restarting Cortex, then watch `C:\ProgramData\Owlette\logs\cortex.log`:

```text
Claude CLI <version> ready from download: …    cache hit, nothing fetched
Adopted the existing Claude CLI <version> …    local binary matched the pin
Claude CLI <version> installed: …              fresh download, checksum verified
```

Corruption handling can be exercised directly: flip a byte in `cache/claude-cli/claude.exe`, delete `version.json`, restart Cortex. The log must show `Checksum verification FAILED!`, `Cached Claude CLI failed the pin — deleting …`, then a clean re-download.

## rollback

Objects are stored per version (`cortex-cli/<version>/claude.exe`), so previous uploads survive. To roll back, re-run the script against the older `claude.exe` (or write the document by hand with that version's `sha256`, `size` and a fresh signed read URL). Machines pick the change up on their next Cortex start: the sidecar's sha256 no longer matches the pin, so the cache is invalidated and the older build is fetched.
