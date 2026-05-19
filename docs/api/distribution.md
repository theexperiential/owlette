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

Prefer a release workflow with npm provenance and PyPI trusted publishing. If a local emergency publish is approved, record the operator, registry account, package, version, and reason in the sprint log.

```powershell
cd cli
npm publish --tag rc --access public
```

```powershell
cd sdks/node
npm publish --tag rc --access public
```

```powershell
cd sdks/python
python -m build --sdist --wheel
python -m twine upload --repository testpypi dist/*
python -m twine upload dist/*
```

After npm publishes, confirm the `rc` tag points at the intended version:

```powershell
npm view @owlette/cli dist-tags
npm view @owlette/sdk dist-tags
```

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

The repository is prepared for RC package dry-runs, but no registry publish has been executed from this sprint environment. Until npm, PyPI, Homebrew, Scoop, and winget installs work or receive an explicit launch waiver, 5.3 remains launch-blocked and not externally complete.
