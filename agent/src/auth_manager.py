"""
Authentication Manager for Owlette Agent

This module manages OAuth authentication for the Owlette agent, handling:
- Registration code exchange for initial authentication
- Access token lifecycle (caching, expiry checking, auto-refresh)
- Secure token storage using encrypted file storage

The agent uses a two-token system:
1. Access Token: Short-lived Firebase custom token (1 hour expiry) for Firestore API calls
2. Refresh Token: Long-lived token (30 days) to obtain new access tokens

Security Features:
- Tokens never logged (even in debug mode)
- Automatic refresh 5 minutes before expiry
- Machine ID validation to prevent token theft
- Encrypted storage via machine-specific key (C:\\ProgramData\\Owlette\\.tokens.enc)

Usage:
    auth = AuthManager(api_base="https://owlette.app/api")

    # First-time setup (during installation)
    auth.exchange_registration_code("abc123...", "DESKTOP-001")

    # Get valid token (auto-refreshes if needed)
    token = auth.get_valid_token()
"""

import requests
import time
import socket
import logging
import json
import threading
from typing import Optional, Dict, Any
from secure_storage import SecureStorage, get_storage
import shared_utils

logger = logging.getLogger(__name__)

# Default token refresh buffer (refresh 5 minutes before expiry)
TOKEN_REFRESH_BUFFER_SECONDS = 5 * 60


class AuthenticationError(Exception):
    """Raised when authentication fails."""
    pass


class TokenRefreshError(Exception):
    """Raised when token refresh fails."""
    pass


class AuthManager:
    """
    Manages OAuth authentication for the Owlette agent.

    Handles token exchange, refresh, and secure encrypted storage
    in C:\\ProgramData\\Owlette\\.tokens.enc (accessible by SYSTEM).
    """

    def __init__(
        self,
        api_base: Optional[str] = "https://owlette.app/api",
        machine_id: Optional[str] = None,
        storage: Optional[SecureStorage] = None,
    ):
        """
        Initialize authentication manager.

        Args:
            api_base: Base URL for API endpoints (e.g., "https://owlette.app/api")
            machine_id: Machine identifier (defaults to hostname)
            storage: Secure storage instance (defaults to singleton)
        """
        if not api_base:
            raise ValueError("api_base is required for AuthManager initialization")
        self.api_base = api_base.rstrip('/')
        self.machine_id = machine_id or socket.gethostname()
        self.storage = storage or get_storage()

        # Token state
        self._access_token: Optional[str] = None
        self._token_expiry: Optional[float] = None
        self._site_id: Optional[str] = None

        # Retry/backoff state for token refresh
        self._last_refresh_attempt: Optional[float] = None
        self._refresh_backoff_seconds: float = 60  # Start with 1 minute
        self._max_backoff_seconds: float = 300  # Max 5 minutes
        self._consecutive_failures: int = 0  # Track consecutive failures
        self._backoff_logged: bool = False  # Track if we've logged backoff message

        # Lock to prevent concurrent token refresh attempts from multiple threads
        self._refresh_lock = threading.Lock()

        # Load cached tokens from storage
        self._load_cached_tokens()

        logger.debug(f"AuthManager initialized: machine={self.machine_id}, api={self.api_base}")

    def _load_cached_tokens(self):
        """Load cached access token and site ID from secure storage."""
        try:
            # Load access token and expiry
            access_token, expiry = self.storage.get_access_token()
            if access_token and expiry:
                self._access_token = access_token
                self._token_expiry = expiry
                logger.debug("Cached access token loaded")

            # Load site ID
            site_id = self.storage.get_site_id()
            if site_id:
                self._site_id = site_id
                logger.debug(f"Site ID loaded: {site_id}")

        except Exception as e:
            logger.warning(f"Failed to load cached tokens: {e}")

    def exchange_registration_code(self, registration_code: str, machine_id: Optional[str] = None) -> bool:
        """
        Exchange registration code for access and refresh tokens.

        This is called during initial setup (installer OAuth flow).
        The registration code is a single-use code embedded in the installer.

        Args:
            registration_code: One-time registration code from installer
            machine_id: Machine identifier (uses self.machine_id if None)

        Returns:
            True if exchange successful, False otherwise

        Raises:
            AuthenticationError: If exchange fails
        """
        machine_id = machine_id or self.machine_id

        try:
            logger.info("Exchanging registration code for tokens...")

            # Call exchange endpoint
            url = f"{self.api_base}/agent/auth/exchange"
            logger.debug(f"Exchange URL: {url}")
            logger.debug(f"Machine ID: {machine_id}")

            # Write to debug log for troubleshooting
            from pathlib import Path
            import shared_utils
            debug_log = Path(shared_utils.get_data_path('logs/oauth_debug.log'))
            with open(debug_log, 'a') as f:
                f.write(f"Calling URL: {url}\n")

            response = requests.post(
                url,
                json={
                    'registrationCode': registration_code,
                    'machineId': machine_id,
                    'version': shared_utils.APP_VERSION,
                },
                timeout=30,
            )
            logger.debug(f"Exchange response status: {response.status_code}")

            # Log response to debug file (omit body — may contain tokens)
            with open(debug_log, 'a') as f:
                f.write(f"Response Status: {response.status_code}\n")
                f.write(f"Response Headers: {dict(response.headers)}\n\n")

            if response.status_code != 200:
                try:
                    error_msg = response.json().get('error', 'Unknown error')
                except (ValueError, json.JSONDecodeError):
                    # Response is not JSON, use status code and text
                    error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
                logger.error(f"Token exchange failed: {error_msg}")
                raise AuthenticationError(f"Token exchange failed: {error_msg}")

            try:
                data = response.json()
            except (ValueError, json.JSONDecodeError) as e:
                logger.error(f"Invalid JSON response from server: {response.text[:200]}")
                raise AuthenticationError(f"Invalid JSON response from server: {e}")

            access_token = data.get('accessToken')
            refresh_token = data.get('refreshToken')
            expires_in = data.get('expiresIn', 3600)
            site_id = data.get('siteId')

            if not access_token or not refresh_token or not site_id:
                raise AuthenticationError("Invalid response from server (missing tokens)")

            # Calculate expiry timestamp
            expiry_timestamp = time.time() + expires_in

            # Store tokens securely
            success_refresh = self.storage.save_refresh_token(refresh_token)
            success_access = self.storage.save_access_token(access_token, expiry_timestamp)
            success_site = self.storage.save_site_id(site_id)

            if not success_refresh or not success_access or not success_site:
                raise AuthenticationError("Failed to save tokens to encrypted file")

            # Update instance state
            self._access_token = access_token
            self._token_expiry = expiry_timestamp
            self._site_id = site_id

            # Log success (don't log actual tokens!)
            logger.info(
                f"Authentication successful: site={site_id}, " +
                f"token_expires_in={expires_in}s"
            )

            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Network error during token exchange: {e}")
            raise AuthenticationError(f"Network error: {e}")
        except Exception as e:
            logger.error(f"Unexpected error during token exchange: {e}")
            raise AuthenticationError(f"Unexpected error: {e}")

    def request_device_code(self) -> dict:
        """
        Request a new device code (pairing phrase) from the server.

        Returns:
            dict with keys: pairPhrase, deviceCode, verificationUri, pairingUrl, expiresIn, interval

        Raises:
            AuthenticationError: If request fails
        """
        try:
            url = f"{self.api_base}/agent/auth/device-code"
            response = requests.post(
                url,
                json={
                    'machineId': self.machine_id,
                    'version': shared_utils.APP_VERSION,
                },
                timeout=30,
            )

            if response.status_code != 200:
                try:
                    error_msg = response.json().get('error', 'Unknown error')
                except (ValueError, json.JSONDecodeError):
                    error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
                raise AuthenticationError(f"Device code request failed: {error_msg}")

            return response.json()

        except requests.exceptions.RequestException as e:
            raise AuthenticationError(f"Network error requesting device code: {e}")

    def poll_device_code(self, device_code: str, interval: int = 5, timeout: int = 600) -> bool:
        """
        Poll the server for device code authorization.

        Blocks until authorized, expired, or timeout. Designed to be called
        from configure_site.py during installation.

        Args:
            device_code: Opaque device code from request_device_code()
            interval: Polling interval in seconds (from server response)
            timeout: Maximum time to poll in seconds

        Returns:
            True if authorized and tokens stored successfully

        Raises:
            AuthenticationError: If polling fails or code expires
        """
        url = f"{self.api_base}/agent/auth/device-code/poll"
        start_time = time.time()

        while time.time() - start_time < timeout:
            try:
                response = requests.post(
                    url,
                    json={'deviceCode': device_code},
                    timeout=15,
                )

                if response.status_code == 202:
                    # Still pending — wait and retry
                    time.sleep(interval)
                    continue

                if response.status_code == 200:
                    # Authorized — extract and store tokens
                    data = response.json()
                    access_token = data.get('accessToken')
                    refresh_token = data.get('refreshToken')
                    expires_in = data.get('expiresIn', 3600)
                    site_id = data.get('siteId')

                    if not access_token or not refresh_token or not site_id:
                        raise AuthenticationError("Invalid response (missing tokens)")

                    expiry_timestamp = time.time() + expires_in

                    # Store tokens securely (same as exchange_registration_code)
                    success_refresh = self.storage.save_refresh_token(refresh_token)
                    success_access = self.storage.save_access_token(access_token, expiry_timestamp)
                    success_site = self.storage.save_site_id(site_id)

                    if not success_refresh or not success_access or not success_site:
                        raise AuthenticationError("Failed to save tokens to encrypted file")

                    self._access_token = access_token
                    self._token_expiry = expiry_timestamp
                    self._site_id = site_id

                    logger.info(f"Device code authorized: site={site_id}")
                    return True

                if response.status_code == 410:
                    raise AuthenticationError("Pairing phrase expired. Please try again.")

                # Other errors
                try:
                    error_msg = response.json().get('error', 'Unknown error')
                except (ValueError, json.JSONDecodeError):
                    error_msg = f"HTTP {response.status_code}"
                raise AuthenticationError(f"Device code poll failed: {error_msg}")

            except requests.exceptions.RequestException as e:
                logger.warning(f"Network error during poll (retrying): {e}")
                time.sleep(interval)
                continue

        raise AuthenticationError("Timed out waiting for authorization")

    def refresh_access_token(self) -> bool:
        """
        Refresh expired access token using refresh token.

        Custom tokens expire after 1 hour, so this must be called periodically.
        The get_valid_token() method handles this automatically.

        Returns:
            True if refresh successful, False otherwise

        Raises:
            TokenRefreshError: If refresh fails
        """
        try:
            logger.debug("Refreshing access token...")

            # Get refresh token from storage
            refresh_token = self.storage.get_refresh_token()
            if not refresh_token:
                raise TokenRefreshError("No refresh token found in storage")

            # Call refresh endpoint
            url = f"{self.api_base}/agent/auth/refresh"
            response = requests.post(
                url,
                json={
                    'refreshToken': refresh_token,
                    'machineId': self.machine_id,
                },
                headers={
                    'User-Agent': f'Owlette-Agent/{shared_utils.APP_VERSION} (Windows; {self.machine_id})',
                    'X-Owlette-Agent-Version': shared_utils.APP_VERSION,
                    'Content-Type': 'application/json',
                },
                timeout=30,
            )

            if response.status_code != 200:
                # Track consecutive failures
                self._consecutive_failures += 1

                # Parse error message
                try:
                    error_msg = response.json().get('error', 'Unknown error')
                except (ValueError, json.JSONDecodeError):
                    error_msg = f"HTTP {response.status_code}: {response.text[:200]}"

                # Classify error type for better logging
                if response.status_code in [401, 403]:
                    error_type = "Authentication failed (invalid/expired tokens)"
                    logger.warning("Refresh token invalid/expired, clearing storage")
                    self.storage.clear_tokens()
                elif response.status_code == 429:
                    error_type = "Rate limited by server"
                elif response.status_code == 500:
                    # Detect rate limiting: 3+ consecutive 500s likely means Cloudflare blocking
                    if self._consecutive_failures >= 3:
                        error_type = "Server error (likely Cloudflare rate limiting/blocking)"
                    else:
                        error_type = "Server error (transient)"
                else:
                    error_type = f"HTTP {response.status_code}"

                logger.error(f"Token refresh failed: {error_type} - {error_msg}")
                raise TokenRefreshError(f"Token refresh failed: {error_msg}")

            try:
                data = response.json()
            except (ValueError, json.JSONDecodeError) as e:
                logger.error(f"Invalid JSON response from server: {response.text[:200]}")
                raise TokenRefreshError(f"Invalid JSON response from server: {e}")
            access_token = data.get('accessToken')
            expires_in = data.get('expiresIn', 3600)

            if not access_token:
                raise TokenRefreshError("Invalid response from server (missing token)")

            # Calculate expiry timestamp
            expiry_timestamp = time.time() + expires_in

            # Update cached token
            self.storage.save_access_token(access_token, expiry_timestamp)

            # Update instance state
            self._access_token = access_token
            self._token_expiry = expiry_timestamp

            # Only log at INFO when recovering from failures (state change)
            was_failing = self._consecutive_failures > 0

            # Reset failure counters on success
            self._consecutive_failures = 0
            self._refresh_backoff_seconds = 60  # Reset backoff to 1 minute

            if was_failing:
                logger.info(f"Token refresh recovered after failures, expires_in={expires_in}s")
            else:
                logger.debug(f"Token refreshed successfully, expires_in={expires_in}s")

            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Network error during token refresh: {e}")
            raise TokenRefreshError(f"Network error: {e}")
        except TokenRefreshError:
            # Re-raise TokenRefreshError as-is
            raise
        except Exception as e:
            logger.error(f"Unexpected error during token refresh: {e}")
            raise TokenRefreshError(f"Unexpected error: {e}")

    def get_valid_token(self) -> str:
        """
        Get a valid access token, refreshing if necessary.

        This method automatically handles token expiry and refresh.
        It should be called before every Firestore API request.

        Returns:
            Valid access token

        Raises:
            AuthenticationError: If no refresh token available and re-auth needed
            TokenRefreshError: If token refresh fails
        """
        # Check if we have a cached token
        if not self._access_token or not self._token_expiry:
            # Try to load from storage
            self._load_cached_tokens()

        # Check if token is expired or about to expire
        if self._token_expiry:
            time_until_expiry = self._token_expiry - time.time()

            # Refresh if token expires in less than 5 minutes
            if time_until_expiry <= TOKEN_REFRESH_BUFFER_SECONDS:
                with self._refresh_lock:
                    # Re-check after acquiring lock — another thread may have refreshed
                    time_until_expiry = self._token_expiry - time.time()
                    if time_until_expiry > TOKEN_REFRESH_BUFFER_SECONDS:
                        return self._access_token

                    # Check backoff - don't retry too soon after previous failure
                    if self._last_refresh_attempt:
                        time_since_last_attempt = time.time() - self._last_refresh_attempt
                        if time_since_last_attempt < self._refresh_backoff_seconds:
                            # Still in backoff period - only log ONCE per backoff period
                            retry_in = int(self._refresh_backoff_seconds - time_since_last_attempt)
                            if not self._backoff_logged:
                                logger.warning(
                                    f"Token refresh in backoff (waiting {int(self._refresh_backoff_seconds)}s, "
                                    f"{self._consecutive_failures} consecutive failures)"
                                )
                                self._backoff_logged = True
                            # Use existing token even if close to expiry (better than spamming)
                            if self._access_token and time_until_expiry > 0:
                                return self._access_token
                            # If token completely expired and still in backoff, raise error
                            raise TokenRefreshError(
                                f"Token expired and refresh in backoff period (retry in {retry_in}s)"
                            )

                    # Attempt refresh - reset backoff log flag since we're trying again
                    self._backoff_logged = False
                    logger.debug(
                        f"Token expires in {int(time_until_expiry)}s (< {TOKEN_REFRESH_BUFFER_SECONDS}s buffer), triggering refresh..."
                    )
                    try:
                        self._last_refresh_attempt = time.time()
                        self.refresh_access_token()
                        logger.debug("Token refresh completed successfully")
                    except TokenRefreshError as e:
                        # Double backoff on failure (exponential backoff)
                        self._refresh_backoff_seconds = min(
                            self._refresh_backoff_seconds * 2,
                            self._max_backoff_seconds
                        )
                        logger.error(
                            f"Token refresh failed, increasing backoff to {int(self._refresh_backoff_seconds)}s "
                            f"({self._consecutive_failures} consecutive failures)"
                        )
                        # If token is still valid (not completely expired), use it
                        if self._access_token and time_until_expiry > 0:
                            logger.warning("Using expiring token due to refresh failure")
                            return self._access_token
                        # Otherwise, re-raise the error
                        raise

        # If we still don't have a token, authentication is required
        if not self._access_token:
            raise AuthenticationError(
                "No valid access token available. Please re-authenticate."
            )

        return self._access_token

    def is_authenticated(self) -> bool:
        """
        Check if agent is authenticated with valid credentials.

        Returns:
            True if refresh token exists in storage, False otherwise
        """
        return self.storage.has_refresh_token()

    def get_site_id(self) -> Optional[str]:
        """
        Get the site ID this agent is authorized for.

        Returns:
            Site ID if authenticated, None otherwise
        """
        if not self._site_id:
            self._site_id = self.storage.get_site_id()
        return self._site_id

    def clear_credentials(self):
        """
        Clear all stored credentials.

        This should be called when:
        - User wants to reconfigure the agent
        - Tokens are revoked by admin
        - Machine is being decommissioned
        """
        logger.info("Clearing all credentials")
        self.storage.clear_tokens()
        self._access_token = None
        self._token_expiry = None
        self._site_id = None

    def get_token_info(self) -> Dict[str, Any]:
        """
        Get information about current token state (for debugging/monitoring).

        Returns:
            Dictionary with token state information
        """
        if self._token_expiry:
            time_until_expiry = max(0, self._token_expiry - time.time())
            is_expired = time_until_expiry <= 0
        else:
            time_until_expiry = None
            is_expired = True

        return {
            'has_access_token': self._access_token is not None,
            'has_refresh_token': self.storage.has_refresh_token(),
            'is_expired': is_expired,
            'time_until_expiry_seconds': int(time_until_expiry) if time_until_expiry else None,
            'site_id': self._site_id,
            'machine_id': self.machine_id,
            'api_base': self.api_base,
        }


# Example usage
if __name__ == "__main__":
    # Configure logging for testing
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    # Example: Exchange registration code
    auth = AuthManager(api_base="https://dev.owlette.app/api")

    # Simulate installer providing registration code
    registration_code = "test_code_12345"  # This would come from installer
    try:
        auth.exchange_registration_code(registration_code)
        print("Authentication successful!")
    except AuthenticationError as e:
        print(f"Authentication failed: {e}")

    # Example: Get valid token (auto-refreshes if needed)
    try:
        token = auth.get_valid_token()
        print("Got valid token successfully")
    except (AuthenticationError, TokenRefreshError) as e:
        print(f"Failed to get token: {e}")

    # Example: Check token info
    info = auth.get_token_info()
    print(f"Token info: {info}")
