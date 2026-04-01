# Testing Guidelines

**Applies To**: `web/` (Jest), `agent/` (pytest), `tests/` (integration)

---

## Quick Reference — Run Commands

```bash
# Web unit tests (72 tests, runs locally, no credentials needed)
cd web && npx jest __tests__/api/ --verbose

# Agent unit tests (66 tests, runs locally)
cd agent && python -m pytest tests/unit/ -v

# Integration tests (40 tests, hits real dev.owlette.app)
cd tests && python -m pytest -m api -v

# All web tests (unit + existing lib tests)
cd web && npm test

# Everything (from repo root)
cd web && npx jest __tests__/api/ && cd ../agent && python -m pytest tests/unit/ -v && cd ../tests && python -m pytest -m api -v
```

---

## Three-Layer Test Architecture

| Layer | Location | Framework | What it tests | Credentials |
|-------|----------|-----------|---------------|-------------|
| **Web unit** | `web/__tests__/api/` | Jest | API route handlers with mocked Firebase | None |
| **Agent unit** | `agent/tests/unit/` | pytest | Agent modules with mocked HTTP/Firestore | None |
| **Integration** | `tests/api/` | pytest + requests | Real endpoints on dev.owlette.app | API key required |

---

## Web Testing (Jest)

### Run Commands
```bash
cd web
npm test                              # Run all tests
npx jest __tests__/api/ --verbose     # API route tests only
npx jest __tests__/api/admin/processes.test.ts  # Single file
npm run test:watch                    # Watch mode
npm run test:coverage                 # With coverage report
```

### Config
- `web/jest.config.js` — uses `next/jest`, `@/` alias works in tests
- `web/jest.setup.js` — mocks Firebase client SDK, sets server env vars, disables rate limiting

### Mocks

**Firebase Client SDK** (`__mocks__/firebase.ts`) — for component/hook tests:
```typescript
import {
  mockGetDoc, mockSetDoc, mockOnSnapshot,
  createMockDocSnapshot, createMockQuerySnapshot, createMockUser,
  resetAllMocks
} from '@/__mocks__/firebase';
```

**Firebase Admin SDK** (`__mocks__/firebase-admin.ts`) — for API route tests:
```typescript
import {
  mockDbGet, mockDbSet, mockDbUpdate, mockDbDelete,
  mockRunTransaction, mockVerifyIdToken,
  mockGetSignedUrl, mockFileExists, mockGetMetadata,
  resetAdminMocks
} from '@/__mocks__/firebase-admin';
```

### API Route Test Pattern

Every API route test file follows this structure:
```typescript
/** @jest-environment node */
import { NextRequest } from 'next/server';

// Strip rate limiting
jest.mock('@/lib/withRateLimit', () => ({ withRateLimit: (handler: any) => handler }));
// Silence logs
jest.mock('@/lib/logger', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, __esModule: true }));
// Mock auth (override per test for failure cases)
jest.mock('@/lib/apiHelpers.server', () => ({
  requireAdminWithSiteAccess: jest.fn().mockResolvedValue({ userId: 'test-admin' }),
  getRouteParam: jest.fn((req, idx) => new URL(req.url).pathname.split('/').filter(Boolean)[idx]),
}));
// Mock firebase-admin (configure mockGet per test)
jest.mock('@/lib/firebase-admin', () => ({ ... }));
```

### What's Tested

| Area | Files | Tests |
|------|-------|-------|
| API: Processes (CRUD + launch mode) | 3 files | ~27 |
| API: Deployments (list, detail, cancel) | 3 files | ~21 |
| API: Installer (latest, upload, versions) | 3 files | ~18 |
| API: Commands (send) | 1 file | 6 |
| Lib: errorHandler, validateEnv | 2 files | 32 |

---

## Agent Testing (pytest)

### Run Commands
```bash
cd agent
pip install -r requirements-dev.txt        # First time
python -m pytest tests/unit/ -v            # All unit tests
python -m pytest tests/unit/test_connection_manager.py -v  # Single file
python -m pytest --cov=src                 # With coverage
python -m pytest -m "not windows"          # Skip Windows-specific
```

### Config: `agent/pytest.ini`, fixtures in `agent/tests/conftest.py`

### Available Fixtures (`conftest.py`)
```python
mock_config              # Standard config dict with processes[]
mock_firebase_credentials  # Mock service account
mock_firestore_db        # MagicMock Firestore client
mock_firebase_app        # MagicMock Firebase app
mock_system_metrics      # CPU/memory/disk/GPU/processes dict
```

### Custom Markers
```python
@pytest.mark.windows     # Windows-only (skip on CI)
@pytest.mark.unit        # Unit tests
@pytest.mark.integration # Integration tests
@pytest.mark.firebase    # Firebase-related (should use mocks)
```

### What's Tested

| Module | File | Tests |
|--------|------|-------|
| connection_manager.py | test_connection_manager.py | ~18 (state machine, backoff, listeners) |
| auth_manager.py | test_auth_manager.py | ~10 (token exchange, refresh, errors) |
| firestore_rest_client.py | test_firestore_rest_client.py | ~24 (value conversion, CRUD) |
| firebase_client.py | test_firebase_client.py | ~8 (init, presence, metrics) |
| shared_utils.py | test_shared_utils.py | ~10 (config, metrics) |

---

## Integration Testing (pytest + requests)

### Setup (one-time)
```bash
cd tests
cp .env.test.example .env.test
# Edit .env.test:
#   OWLETTE_API_URL=https://dev.owlette.app
#   OWLETTE_API_KEY=owk_your_key_here    # Generate from Admin > API Keys
#   OWLETTE_SITE_ID=your-site-id
#   OWLETTE_MACHINE_ID=your-machine-id
pip install -r requirements.txt
```

### Run Commands
```bash
cd tests
python -m pytest -m api -v              # All API tests
python -m pytest api/test_processes.py -v  # Single file
python -m pytest -m readonly -v          # Safe read-only tests only
python -m pytest -m "api and not destructive" -v  # Skip create/delete tests
```

### Test Files

| File | Tests | What |
|------|-------|------|
| test_auth.py | 4 | Auth rejection (no auth, invalid key, invalid token, valid key) |
| test_machines.py | 4 | List machines, machine status, missing params |
| test_processes.py | 14 | Full CRUD lifecycle + validation errors |
| test_commands.py | 4 | Fire-and-forget, wait mode, missing fields |
| test_deployments.py | 9 | Create → list → detail → cancel + validation |
| test_installer.py | 3 | Latest metadata, version listing |

### Markers
```python
@pytest.mark.api         # All API tests
@pytest.mark.readonly    # Safe — only reads data
@pytest.mark.destructive # Creates/modifies data (has cleanup fixtures)
@pytest.mark.integration # Integration tests
```

### Cleanup

Tests that create resources (processes, deployments) use cleanup fixtures that auto-delete in teardown:
```python
def test_create(self, api_client, process_cleanup):
    resp = api_client.post("/api/admin/processes", json={...})
    process_cleanup.append(resp.json()["processId"])  # Auto-deleted after test
```

---

## Principles

1. **Mock Firebase, not business logic** — Firebase is the I/O boundary
2. **Use existing mocks** — `__mocks__/firebase.ts`, `__mocks__/firebase-admin.ts`, and `conftest.py` have what you need
3. **Test error paths** — Firebase operations fail in production
4. **Don't test shadcn/ui** — test your composition of primitives, not the primitives
5. **API route tests use `/** @jest-environment node */`** — server code, not jsdom
6. **Integration tests need `.env.test`** — never commit credentials
