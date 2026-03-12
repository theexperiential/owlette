# Testing Guidelines

**Version**: 1.0.0
**Last Updated**: 2026-03-12
**Applies To**: Both `web/` (Jest) and `agent/` (pytest)

---

## Web Testing (Jest + React Testing Library)

### Configuration
- **Framework**: Jest 29 with `jsdom` environment
- **Config**: `web/jest.config.js` (uses `next/jest` transformer)
- **Setup**: `web/jest.setup.js`
- **Path alias**: `@/` maps to `web/` root (matches tsconfig)
- **Auto-clear**: Mocks cleared before every test

### Run Commands
```bash
cd web
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage report
```

### Directory Structure
```
web/
├── __tests__/
│   ├── lib/                    # Utility tests
│   │   ├── errorHandler.test.ts   # 17 tests - Firebase error mapping
│   │   └── validateEnv.test.ts    # 15 tests - Env validation
│   ├── hooks/                  # Hook tests (TODO)
│   └── components/             # Component tests (TODO)
├── __mocks__/
│   ├── firebase.ts             # Comprehensive Firebase mock
│   ├── fileMock.js             # Image import mock
│   └── styleMock.js            # CSS import mock
```

### Firebase Mock (`__mocks__/firebase.ts`)

Pre-built mocks for all common Firebase operations:

```typescript
import {
  mockGetDoc, mockSetDoc, mockOnSnapshot,      // Firestore
  mockSignInWithEmailAndPassword, mockSignOut,  // Auth
  createMockDocSnapshot,                         // Helper: mock document
  createMockQuerySnapshot,                       // Helper: mock query results
  createMockUser,                                // Helper: mock Firebase user
  resetAllMocks                                  // Reset all mocks
} from '@/__mocks__/firebase';
```

**Always call `resetAllMocks()` in `afterEach`** to prevent test pollution.

### Test Patterns

**Utility test pattern** (lib files):
```typescript
import { myFunction } from '@/lib/myFile';

describe('myFunction', () => {
  it('should handle expected input', () => {
    const result = myFunction('input');
    expect(result).toBe('expected');
  });

  it('should handle error cases', () => {
    expect(() => myFunction(null)).toThrow();
  });
});
```

**Hook test pattern** (with Firebase mocks):
```typescript
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMyHook } from '@/hooks/useMyHook';

// Mock Firebase modules
jest.mock('@/lib/firebase', () => ({
  db: mockDb,
  auth: mockAuth,
}));

describe('useMyHook', () => {
  afterEach(() => resetAllMocks());

  it('should return data', async () => {
    mockOnSnapshot.mockImplementation((ref, callback) => {
      callback(createMockQuerySnapshot([{ name: 'test' }]));
      return jest.fn(); // unsubscribe
    });

    const { result } = renderHook(() => useMyHook());
    await waitFor(() => expect(result.current.data).toHaveLength(1));
  });
});
```

**Component test pattern**:
```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { MyComponent } from '@/components/MyComponent';

describe('MyComponent', () => {
  it('should render correctly', () => {
    render(<MyComponent title="Test" />);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('should handle user interaction', async () => {
    const onSubmit = jest.fn();
    render(<MyComponent onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onSubmit).toHaveBeenCalled();
  });
});
```

### What's Tested vs Gaps

**Currently tested**:
- `errorHandler.ts` — 17 tests: Firebase error code mapping, sanitization, production mode
- `validateEnv.ts` — 15 tests: Environment variable validation

**Ready for expansion** (infrastructure exists, no tests yet):
- Custom hooks (`useFirestore`, `useDeployments`, etc.) — use `renderHook` + Firebase mocks
- Components — use `render` + `screen` queries
- API routes — use Next.js test utilities
- AuthContext — mock Firebase auth state changes

---

## Agent Testing (pytest)

### Configuration
- **Framework**: pytest 7.4 with coverage
- **Config**: `agent/pytest.ini`
- **Fixtures**: `agent/tests/conftest.py`
- **Mocking**: `pytest-mock` + `unittest.mock`

### Run Commands
```bash
cd agent
pip install -r requirements-dev.txt   # First time
pytest                                 # Run all tests
pytest -v                              # Verbose
pytest --cov=src                       # With coverage
pytest -m unit                         # Unit tests only
pytest -m "not windows"                # Skip Windows-specific
```

### Directory Structure
```
agent/
├── tests/
│   ├── conftest.py                # Shared fixtures (auto-loaded)
│   ├── unit/
│   │   └── test_shared_utils.py   # Config + metrics tests
│   └── integration/               # (TODO)
```

### Available Fixtures (`conftest.py`)

```python
mock_config              # Standard config dict with processes[]
mock_firebase_credentials  # Mock service account (legacy pattern)
mock_firestore_db        # MagicMock Firestore client
mock_firebase_app        # MagicMock Firebase app
mock_system_metrics      # CPU/memory/disk/GPU/processes dict
```

### Custom Markers
```python
@pytest.mark.windows     # Windows-only tests (skip on CI)
@pytest.mark.unit        # Unit tests
@pytest.mark.integration # Integration tests
```

### Test Patterns

**Config/utility test pattern**:
```python
from shared_utils import read_config, load_config

def test_read_config_returns_value(mock_config, tmp_path):
    config_file = tmp_path / "config.json"
    config_file.write_text(json.dumps(mock_config))
    # patch CONFIG_PATH to tmp_path
    result = read_config(['firebase', 'enabled'])
    assert result is True
```

**Service test pattern** (mock Windows APIs):
```python
from unittest.mock import patch, MagicMock

@pytest.mark.windows
def test_handle_process_launch():
    with patch('owlette_service.subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        # Test process launch logic
```

**Firebase client test pattern**:
```python
def test_firebase_client_offline(mock_config):
    with patch('firebase_client.AuthManager') as MockAuth:
        MockAuth.return_value.get_valid_token.return_value = "test-token"
        # Test offline cache behavior
```

### What's Tested vs Gaps

**Currently tested**:
- `shared_utils.py` — Config loading, system metrics retrieval

**Ready for expansion**:
- `connection_manager.py` — State transitions, circuit breaker logic (highly testable, no Windows deps)
- `auth_manager.py` — Token refresh timing, error handling
- `secure_storage.py` — Encryption/decryption round-trip
- `firebase_client.py` — Offline caching, command parsing
- `owlette_service.py` — Process state machine, relaunch limits (mock psutil + win32)

---

## General Testing Principles

1. **Mock Firebase, not business logic** — Firebase calls are I/O boundaries; test the logic around them
2. **Use existing mocks** — `__mocks__/firebase.ts` and `conftest.py` have comprehensive fixtures
3. **Test error paths** — Firebase operations fail in production; test error handling
4. **Don't test shadcn/ui** — UI primitives are third-party; test your composition of them
5. **Keep tests fast** — No network calls, no file I/O (mock everything external)
6. **Name tests descriptively** — `it('should return error message for invalid email')` not `it('test1')`
