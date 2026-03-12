# Testing Guidelines

**Applies To**: Both `web/` (Jest) and `agent/` (pytest)

---

## Web Testing (Jest)

### Run Commands
```bash
cd web
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage report
```

### Config: `web/jest.config.js` (uses `next/jest`), setup in `web/jest.setup.js`, `@/` alias works in tests.

### Firebase Mock (`__mocks__/firebase.ts`)

Pre-built mocks exist — use them, don't create new Firebase mocks:

```typescript
import {
  mockGetDoc, mockSetDoc, mockOnSnapshot,      // Firestore ops
  mockSignInWithEmailAndPassword, mockSignOut,  // Auth ops
  createMockDocSnapshot, createMockQuerySnapshot, createMockUser,  // Helpers
  resetAllMocks                                 // Call in afterEach!
} from '@/__mocks__/firebase';
```

### What's Tested vs Gaps

**Tested**: `errorHandler.ts` (17 tests), `validateEnv.ts` (15 tests)

**Ready for expansion** (infrastructure exists, no tests yet): custom hooks (use `renderHook` + Firebase mocks), components (use `render` + `screen`), AuthContext, API routes

---

## Agent Testing (pytest)

### Run Commands
```bash
cd agent
pip install -r requirements-dev.txt   # First time
pytest                                 # Run all
pytest -v                              # Verbose
pytest --cov=src                       # With coverage
pytest -m unit                         # Unit tests only
pytest -m "not windows"                # Skip Windows-specific
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
```

### What's Tested vs Gaps

**Tested**: `shared_utils.py` (config loading, system metrics)

**High-value expansion targets** (testable, no Windows deps): `connection_manager.py` (state machine, circuit breaker), `auth_manager.py` (token refresh timing), `secure_storage.py` (encryption round-trip), `firebase_client.py` (offline cache, command parsing)

---

## Principles

1. **Mock Firebase, not business logic** — Firebase is the I/O boundary
2. **Use existing mocks** — `__mocks__/firebase.ts` and `conftest.py` have what you need
3. **Test error paths** — Firebase operations fail in production
4. **Don't test shadcn/ui** — test your composition of primitives, not the primitives
