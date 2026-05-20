"""
Root-level Integration Test Configuration

Loads environment variables and provides shared fixtures for all integration tests.
Requires a .env.test file (or environment variables) with API credentials.
"""

import os
import pytest
import requests
from pathlib import Path

# Load .env.test if it exists
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent / '.env.test'
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass  # python-dotenv not installed, rely on environment variables


def _require_env(name: str) -> str:
    """Get a required environment variable or skip the test."""
    value = os.environ.get(name)
    if not value:
        pytest.skip(f"Missing required environment variable: {name}")
    return value


@pytest.fixture(scope="session")
def api_url() -> str:
    """Base URL for the Owlette API (e.g. https://dev.owlette.app)."""
    return _require_env("OWLETTE_API_URL").rstrip("/")


@pytest.fixture(scope="session")
def api_key() -> str:
    """API key for authentication (owk_...)."""
    return _require_env("OWLETTE_API_KEY")


@pytest.fixture(scope="session")
def site_id() -> str:
    """Target site ID for tests."""
    return _require_env("OWLETTE_SITE_ID")


@pytest.fixture(scope="session")
def machine_id() -> str:
    """Target machine ID for tests."""
    return _require_env("OWLETTE_MACHINE_ID")


@pytest.fixture(scope="session")
def command_timeout() -> int:
    """Timeout in seconds for wait-mode command tests."""
    return int(os.environ.get("OWLETTE_COMMAND_TIMEOUT", "30"))


@pytest.fixture(scope="session")
def auth_session(api_url, api_key) -> requests.Session:
    """Authenticated requests session with API key header pre-set."""
    session = requests.Session()
    session.headers.update({
        "x-api-key": api_key,
        "Content-Type": "application/json",
    })
    return session
