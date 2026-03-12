# Owlette Version Management System

⚠️ **This document has been superseded by the new monorepo-wide version management system.**

**See instead:** [docs/version-management.md](../docs/version-management.md)

---

## Quick Reference

**Current Version:** 2.0.4

**For Releases, Use the Sync Script:**
```bash
# Check current versions
node scripts/sync-versions.js

# Bump to new version
node scripts/sync-versions.js 2.1.0
```

This automatically updates:
- `/VERSION` (product)
- `agent/VERSION` (agent)
- `web/package.json` (web)

**Legacy (Agent-Only) Method:**

If you only need to bump the agent version independently:

```bash
echo 2.0.4 > agent/VERSION
cd agent
build_installer_quick.bat
```

However, for releases, always use the sync script to keep all components aligned.

---

## How It Works

### Version Flow Diagram

```
agent/VERSION (single line: "2.0.3")
    │
    ├─> shared_utils.py (reads at import time)
    │   └─> APP_VERSION = get_app_version()
    │       │
    │       ├─> owlette_tray.py (imports shared_utils.APP_VERSION)
    │       │   └─> Displays in system tray menu
    │       │
    │       ├─> owlette_gui.py (imports shared_utils.APP_VERSION)
    │       │   └─> Displays in config GUI
    │       │
    │       ├─> firebase_client.py (imports shared_utils.APP_VERSION)
    │       │   └─> Reports to Firestore as agent_version
    │       │
    │       └─> auth_manager.py (imports shared_utils.APP_VERSION)
    │           └─> Sends to OAuth registration API
    │
    └─> build_installer_full.bat or build_installer_quick.bat (reads at build time)
        └─> Sets OWLETTE_VERSION environment variable
            └─> owlette_installer.iss (reads from env var)
                └─> Installer filename: Owlette-Installer-v2.0.3.exe
```

### Implementation Details

#### 1. Runtime Version Reading (Python)

**File:** `agent/src/shared_utils.py`

```python
from pathlib import Path

def get_app_version():
    """
    Read application version from VERSION file.
    This ensures a single source of truth for version management.
    """
    try:
        # VERSION file is in agent/ directory (parent of src/)
        version_file = Path(__file__).parent.parent / 'VERSION'
        if version_file.exists():
            return version_file.read_text().strip()
        else:
            # Fallback for development or if VERSION file is missing
            return '2.0.3'  # Hardcoded fallback
    except Exception as e:
        # If anything goes wrong, use fallback version
        return '2.0.3'

APP_VERSION = get_app_version()
```

**All other Python files import from shared_utils:**
```python
import shared_utils

# Use shared_utils.APP_VERSION everywhere
print(f"Agent version: {shared_utils.APP_VERSION}")
```

#### 2. Build Time Version Reading (Batch Scripts)

**Files:** `agent/build_installer_full.bat` and `agent/build_installer_quick.bat`

```batch
:: Read version from VERSION file
set /p OWLETTE_VERSION=<VERSION
if "!OWLETTE_VERSION!"=="" (
    echo ERROR: VERSION file is empty!
    exit /b 1
)

echo Building Owlette version: !OWLETTE_VERSION!

:: Later, when calling Inno Setup:
"%INNO_PATH%" owlette_installer.iss
```

The `OWLETTE_VERSION` environment variable is automatically passed to Inno Setup.

#### 3. Installer Version Reading (Inno Setup)

**File:** `agent/owlette_installer.iss`

```pascal
; Read version from environment variable set by build script
#ifndef MyAppVersion
  #define MyAppVersion GetEnv("OWLETTE_VERSION")
  #if MyAppVersion == ""
    #define MyAppVersion "2.0.3"
    #pragma message "WARNING: Using fallback version"
  #endif
#endif
```

---

## Version Usage Locations

### Where Version is Displayed/Used

| Location | File | Line | Purpose |
|----------|------|------|---------|
| **System Tray** | `agent/src/owlette_tray.py` | 506 | Shows "Version: X.X.X" in tray menu |
| **Config GUI** | `agent/src/owlette_gui.py` | 283 | Shows "vX.X.X" in bottom-right |
| **Firestore** | `agent/src/firebase_client.py` | 418, 440 | Reports as `agent_version` field |
| **OAuth API** | `agent/src/auth_manager.py` | 151 | Sends in registration payload |
| **Installer Name** | `agent/owlette_installer.iss` | 62 | `Owlette-Installer-vX.X.X.exe` |

### Files Modified (2025-11-05)

1. ✅ `agent/VERSION` - Created (single source of truth)
2. ✅ `agent/src/shared_utils.py` - Added `get_app_version()` function
3. ✅ `agent/src/auth_manager.py` - Removed duplicate `AGENT_VERSION`, imports from shared_utils
4. ✅ `agent/owlette_installer.iss` - Reads from `OWLETTE_VERSION` env var
5. ✅ `agent/build_installer_full.bat` (renamed from build_embedded_installer.bat) - Validates VERSION file, sets env var
6. ✅ `agent/build_installer_quick.bat` - Created quick rebuild script
7. ✅ `agent/README.md` - Added Version Management section and build options

---

## What NOT To Do

### ❌ DO NOT Manually Edit These Files For Version Bumps:

1. **`agent/src/shared_utils.py`**
   - Has `APP_VERSION = get_app_version()`
   - Reads from VERSION file automatically

2. **`agent/src/auth_manager.py`**
   - Imports from `shared_utils.APP_VERSION`
   - No local version constant

3. **`agent/owlette_installer.iss`**
   - Reads from `OWLETTE_VERSION` environment variable
   - Build script sets this automatically

### ❌ DO NOT Create Duplicate Version Constants

If you need the version in a new file:
```python
import shared_utils

# Use this:
version = shared_utils.APP_VERSION

# NOT this:
VERSION = "2.0.3"  # ❌ Creates duplicate!
```

---

## Validation & Testing

### Quick Test (After Version Bump)

```bash
# 1. Check VERSION file
type agent\VERSION

# 2. Test Python reads it correctly
cd agent\src
python -c "import shared_utils; print(f'Version: {shared_utils.APP_VERSION}')"

# 3. Build and check installer filename
cd agent
build_installer_full.bat         # Or build_installer_quick.bat if build/ exists
# Should output: build\installer_output\Owlette-Installer-v2.0.X.exe
```

### Expected Output
```
Version: 2.0.3
```

### Troubleshooting

**Problem:** Version still shows old version after rebuild

**Solution:**
1. Check `agent/VERSION` file contains new version
2. Delete `agent/build` directory: `rmdir /s /q agent\build`
3. Rebuild installer: `cd agent && build_installer_full.bat`
4. Run new installer and check system tray

**Problem:** Build script says "VERSION file not found"

**Solution:**
- Ensure file exists at `agent/VERSION` (not in `agent/src/`)
- File should contain single line with version (e.g., `2.0.3`)
- No quotes, no extra whitespace

**Problem:** System tray shows "Version: 2.0.3" but Firestore shows different version

**Solution:**
- Old agent is still running - restart the Owlette service:
  ```bash
  net stop OwletteService
  net start OwletteService
  ```

---

## Historical Context

### Why This System Was Needed

**Problem (Before 2025-11-05):**
- Version was defined in **5+ different locations**
- `shared_utils.py`: `APP_VERSION = '2.0.0'`
- `auth_manager.py`: `AGENT_VERSION = "2.0.3"`
- `owlette_installer.iss`: `#define MyAppVersion "2.0.3"`
- `configure_site.py`: Default config had `"version": "2.0.3"`
- `web/package.json`: `"version": "2.0.0"`

**Issue:**
- When v2.0.3 installer was built, `owlette_installer.iss` was updated
- But `shared_utils.APP_VERSION` was NOT updated
- Result: System tray showed "Version: 2.0.0" even after running 2.0.3 installer
- Users were confused - no visibility into which version was actually running

**Solution (Single Source of Truth):**
- Created `agent/VERSION` file
- All code reads from this file (directly or indirectly)
- Build validation ensures VERSION exists before compiling
- Version automatically propagates everywhere

### Design Goals

1. **Simple** - Edit one file, rebuild, done
2. **Elegant** - No complex version generation scripts
3. **Foolproof** - Build fails if VERSION missing
4. **Maintainable** - Clear documentation for future developers
5. **Visible** - Build script displays version being built

---

## For AI Agents / Future Developers

### Quick Reference

**To bump version:**
```bash
echo 2.0.4 > agent/VERSION
cd agent && build_installer_full.bat         # Full build
cd agent && build_installer_quick.bat        # Quick build (if build/ exists)
```

**To find version:**
```bash
type agent\VERSION
```

**To verify version in code:**
```bash
cd agent\src && python -c "import shared_utils; print(shared_utils.APP_VERSION)"
```

**Key Files:**
- `agent/VERSION` - Single source of truth (one line, no quotes)
- `agent/src/shared_utils.py:19-41` - Reads VERSION file
- `agent/build_installer_full.bat` - Full build script (validates and reads VERSION)
- `agent/build_installer_quick.bat` - Quick build script (validates and reads VERSION)
- `agent/owlette_installer.iss:41-54` - Uses env var from build scripts

**Important:** Never create duplicate version constants. Always import from `shared_utils.APP_VERSION`.

---

## Changelog

### 2025-11-05 - Version Management System Implementation

**Created:**
- `agent/VERSION` file (2.0.3)
- `.claude/VERSION-MANAGEMENT.md` (this document)

**Modified:**
- `agent/src/shared_utils.py` - Added `get_app_version()` function
- `agent/src/auth_manager.py` - Removed `AGENT_VERSION`, imports from shared_utils
- `agent/owlette_installer.iss` - Reads from environment variable
- `agent/build_installer_full.bat` (renamed from build_embedded_installer.bat) - Validates VERSION file, sets env var
- `agent/build_installer_quick.bat` - Created quick rebuild script (~30 sec vs 5-10 min)
- `agent/README.md` - Added "Version Management" section with build options
- `.claude/CLAUDE.md` - Added build options documentation
- `.claude/VERSION-MANAGEMENT.md` - Updated with build options

**Result:**
- ✅ Single source of truth for version management
- ✅ Version automatically propagates to all components
- ✅ Build-time validation prevents missing version
- ✅ Simple 2-step version bump process

---

**Questions?** See `agent/README.md` or contact the development team.
