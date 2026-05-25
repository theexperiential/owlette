# SDK and CLI distribution

**Last updated**: 2026-04-29

External public launch requires installable SDK and CLI packages. Developer preview can proceed without registry publication, but external launch should not.

No registry publish should be run from a local shell unless a package owner explicitly approves the release, the target version, and the registry account in use.

---

## package targets

| channel | package | target version | current status |
|---|---|---:|---|
| npm CLI | `@owlette/cli` | `1.0.0-rc.0` | metadata prepared; publish pending |
| npm SDK | `@owlette/sdk` | `1.0.0-rc.1` | metadata prepared; publish pending |
| PyPI SDK | `owlette-sdk` | `1.0.0rc0` | metadata prepared; publish pending |
| Homebrew | `owlette` | `1.0.0-rc.0` | blocked until release artifact URL and checksum exist |
| Scoop | `owlette` | `1.0.0-rc.0` | blocked until release artifact URL and checksum exist |
| winget | `Owlette.CLI` | `1.0.0-rc.0` | blocked until the Windows install shape and checksum are final |

Python uses the PEP 440 spelling `1.0.0rc0`. Release notes can describe this as the same RC family as `1.0.0-rc.0`.

---

## launch gate

5.3 is externally complete when:

- npm and PyPI package ownership, two-factor authentication, and recovery access are verified
- package-local license files are present in the CLI, Node SDK, and Python SDK artifacts
- dry-run package builds pass from a clean checkout
- `@owlette/cli` and `@owlette/sdk` publish under the npm `rc` dist-tag
- `owlette-sdk` publishes to TestPyPI, then PyPI, as a pre-release
- clean-machine install smoke tests pass for npm and PyPI
- Homebrew, Scoop, and winget install commands work from the intended public channels or have an approved launch waiver
- docs are updated from "release target" wording to "published package" wording

---

## dry-run checks

Run these before requesting the registry publish.

```powershell
cd cli
npm ci
npm run build
npm test
npm pack --dry-run
```

```powershell
cd sdks/node
npm ci
npm run build
npm test
npm pack --dry-run
```

```powershell
cd sdks/python
python -m build --sdist --wheel
python -m twine check dist/*
```

Do not commit generated `dist/`, `.egg-info/`, or package archive files. They are release artifacts, not source.

---

## publish sequence

Publishing is driven by CI from release tags using OIDC trusted publishing — no long-lived registry tokens live in GitHub secrets. The dist-tag is derived from the package version automatically: a prerelease (e.g. `1.0.0-rc.0`) publishes under the `rc` tag, a stable version under `latest`.

| package | workflow | release tag |
|---|---|---|
| `@owlette/cli` | `.github/workflows/cli-publish.yml` | `cli-vX.Y.Z[-pre]` |
| `@owlette/sdk` | `.github/workflows/node-sdk-publish.yml` | `node-sdk-vX.Y.Z[-pre]` |
| `owlette-sdk` | `.github/workflows/py-sdk-publish.yml` | `py-sdk-v<PEP440>` (e.g. `py-sdk-v1.0.0rc0`) |

Each workflow also supports `workflow_dispatch` with a dry-run default so package contents can be validated before a real publish.

### one-time trusted-publisher setup

- **npm** cannot attach a trusted publisher to a package that does not exist yet, so the first publish of each npm package must be bootstrapped once. Sign in locally with the package owner account (2FA enabled) and run a single `npm publish --tag rc --access public` from `cli/` and from `sdks/node/`. Then, in each package's settings on npmjs.com, add a GitHub Actions trusted publisher pointing at the workflow above. Every release after that goes through CI tokenlessly with provenance.
- **PyPI** supports a "pending publisher" that creates the project on first publish, so no bootstrap and no token is needed. Configure the pending publisher (project `owlette-sdk`, this repo's owner/name, workflow `py-sdk-publish.yml`, environment left blank) before pushing the first `py-sdk-v*` tag. The name is not reserved until that first publish, so tag promptly.

### releasing

```powershell
# example: cut the CLI rc release
git tag cli-v1.0.0-rc.0
git push origin cli-v1.0.0-rc.0   # → cli-publish.yml publishes @owlette/cli@rc with provenance
```

After npm publishes, confirm the dist-tag points at the intended version:

```powershell
npm view @owlette/cli dist-tags
npm view @owlette/sdk dist-tags
```

If a local emergency publish is approved (registry/CI outage), record the operator, registry account, package, version, and reason in the sprint log before running `npm publish` / `twine upload` by hand.

---

## install verification

Run install tests in a clean temporary directory or disposable VM.

```powershell
npm install -g @owlette/cli@rc
owlette --version
roost --version
```

```powershell
npm install @owlette/sdk@rc
node -e "const { VERSION } = require('@owlette/sdk'); console.log(VERSION)"
```

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install --pre owlette-sdk==1.0.0rc0
.\.venv\Scripts\python -c "import roost; print(roost.__version__)"
```

Package-manager channel checks:

```powershell
brew install owlette
scoop install owlette
winget install Owlette.CLI
```

Homebrew, Scoop, and winget remain blocked until there is a stable release artifact URL and published SHA-256 checksum for each manifest.

---

## current status

OIDC trusted-publishing workflows are wired for all three packages and the RC builds pass clean-checkout dry-runs. No registry publish has been executed yet. Remaining owner steps before the first publish: create the `@owlette` npm org with 2FA, bootstrap the first npm publish of each package, configure the npm trusted publishers, and configure the PyPI pending publisher for `owlette-sdk`; PyPI creates the project on first OIDC publish, so publish promptly after the pending publisher is set. Until npm, PyPI, Homebrew, Scoop, and winget installs work or receive an explicit launch waiver, 5.3 remains launch-blocked and not externally complete.
