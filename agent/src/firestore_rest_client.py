"""
Firestore REST API Client for Owlette Agent

This module provides a Python client for Firestore REST API v1, replacing
the Firebase Admin SDK. It uses custom tokens for authentication instead of
service account credentials.

Security: This client enforces Firestore security rules (unlike Admin SDK).
All operations are scoped to the authenticated user's permissions.

API Documentation:
https://firebase.google.com/docs/firestore/reference/rest

Usage:
    from auth_manager import AuthManager
    from firestore_rest_client import FirestoreRestClient

    auth = AuthManager()
    firestore = FirestoreRestClient(project_id="owlette-dev", auth_manager=auth)

    # Set document
    firestore.set_document('sites/abc/machines/DESKTOP-001', {'online': True})

    # Get document
    data = firestore.get_document('sites/abc/machines/DESKTOP-001')

    # Update document
    firestore.update_document('sites/abc/machines/DESKTOP-001', {'cpu': 25.5})

    # Real-time listener
    def callback(data):
        print(f"Document updated: {data}")
    firestore.listen_to_document('config/abc/machines/DESKTOP-001', callback)
"""

import hashlib
import requests
import json
import re
import time
import threading
import logging
from typing import Dict, Any, Optional, Callable, List
from datetime import datetime
from urllib.parse import quote

logger = logging.getLogger(__name__)

# Firestore REST API base URL
FIRESTORE_API_BASE = "https://firestore.googleapis.com/v1"

# Special value for server timestamp
SERVER_TIMESTAMP = "SERVER_TIMESTAMP"

def timestamp_to_ms(value) -> int:
    """Convert a Firestore timestamp value to epoch milliseconds.

    Handles all formats returned by the REST API or written by web clients:
      - int/float: assumed to be epoch milliseconds already
      - ISO 8601 string: parsed to epoch ms (Firestore REST returns this for Timestamp fields)
      - None or unrecognised: returns 0
    """
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            # Firestore returns e.g. '2026-04-02T14:30:00.123456Z'
            # Strip trailing 'Z' and parse as UTC
            cleaned = value.rstrip('Z')
            dt = datetime.fromisoformat(cleaned)
            return int(dt.timestamp() * 1000)
        except (ValueError, OSError):
            return 0
    return 0


# Special sentinel value for deleting fields (compatible with firebase_admin SDK)
class _DeleteFieldSentinel:
    """Sentinel class to mark fields for deletion (matches firebase_admin.firestore.DELETE_FIELD)"""
    def __repr__(self):
        return "DELETE_FIELD"

DELETE_FIELD = _DeleteFieldSentinel()


class FirestoreRestClient:
    """
    Firestore REST API client using custom token authentication.

    This client provides methods for CRUD operations, real-time listeners,
    and batch writes - matching the interface of firebase_admin SDK.
    """

    def __init__(self, project_id: str, auth_manager):
        """
        Initialize Firestore REST client.

        Args:
            project_id: Firebase project ID (e.g., "owlette-dev-3838a")
            auth_manager: AuthManager instance for token management
        """
        self.project_id = project_id
        self.auth_manager = auth_manager
        self.base_url = f"{FIRESTORE_API_BASE}/projects/{project_id}/databases/(default)/documents"

        # HTTP session for connection pooling
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
        })

        logger.debug(f"FirestoreRestClient initialized: project={project_id}")

    def _get_auth_headers(self) -> Dict[str, str]:
        """
        Get authorization headers with fresh access token.

        Returns:
            Dict with Authorization header
        """
        token = self.auth_manager.get_valid_token()
        return {
            'Authorization': f'Bearer {token}',
        }

    def _to_firestore_value(self, value: Any) -> Dict[str, Any]:
        """
        Convert Python value to Firestore REST API format.

        Args:
            value: Python value (int, str, bool, dict, list, etc.)

        Returns:
            Firestore value object

        Examples:
            42 → {'integerValue': '42'}
            'test' → {'stringValue': 'test'}
            True → {'booleanValue': True}
            SERVER_TIMESTAMP → {'timestampValue': '2025-11-02T14:30:00.000000Z'}
        """
        if value is None:
            return {'nullValue': None}
        elif isinstance(value, _DeleteFieldSentinel):
            # Special marker for field deletion
            return None  # Signal to caller to handle as deletion
        elif value == SERVER_TIMESTAMP:
            # SERVER_TIMESTAMP should be extracted by _extract_server_timestamps()
            # before reaching here. If it does, fall back to client time with warning.
            logger.warning("SERVER_TIMESTAMP not extracted before conversion - using client time as fallback")
            return {'timestampValue': datetime.utcnow().isoformat() + 'Z'}
        elif isinstance(value, bool):
            return {'booleanValue': value}
        elif isinstance(value, int):
            return {'integerValue': str(value)}
        elif isinstance(value, float):
            return {'doubleValue': value}
        elif isinstance(value, str):
            return {'stringValue': value}
        elif isinstance(value, dict):
            # Convert nested dict to map
            fields = {k: self._to_firestore_value(v) for k, v in value.items()}
            return {'mapValue': {'fields': fields}}
        elif isinstance(value, list):
            # Convert list to array
            values = [self._to_firestore_value(item) for item in value]
            return {'arrayValue': {'values': values}}
        elif isinstance(value, datetime):
            return {'timestampValue': value.isoformat() + 'Z'}
        else:
            # Fallback to string
            return {'stringValue': str(value)}

    def _from_firestore_value(self, firestore_value: Dict[str, Any]) -> Any:
        """
        Convert Firestore REST API format to Python value.

        Args:
            firestore_value: Firestore value object

        Returns:
            Python value
        """
        if 'nullValue' in firestore_value:
            return None
        elif 'booleanValue' in firestore_value:
            return firestore_value['booleanValue']
        elif 'integerValue' in firestore_value:
            return int(firestore_value['integerValue'])
        elif 'doubleValue' in firestore_value:
            return firestore_value['doubleValue']
        elif 'stringValue' in firestore_value:
            return firestore_value['stringValue']
        elif 'timestampValue' in firestore_value:
            # Return as ISO string (can parse to datetime if needed)
            return firestore_value['timestampValue']
        elif 'mapValue' in firestore_value:
            # Convert nested map to dict
            fields = firestore_value['mapValue'].get('fields', {})
            return {k: self._from_firestore_value(v) for k, v in fields.items()}
        elif 'arrayValue' in firestore_value:
            # Convert array to list
            values = firestore_value['arrayValue'].get('values', [])
            return [self._from_firestore_value(item) for item in values]
        else:
            return None

    def _to_firestore_document(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert Python dict to Firestore document format.

        Args:
            data: Python dictionary

        Returns:
            Firestore document with 'fields' object
        """
        fields = {k: self._to_firestore_value(v) for k, v in data.items()}
        return {'fields': fields}

    def _extract_server_timestamps(self, data: Dict[str, Any], prefix: str = ""):
        """
        Extract SERVER_TIMESTAMP sentinel values from a data dict.

        Returns:
            (cleaned_data, timestamp_field_paths) where cleaned_data has
            SERVER_TIMESTAMP entries removed and timestamp_field_paths is
            a list of escaped dotted field paths for use in fieldTransforms.
        """
        cleaned = {}
        field_paths = []

        for key, value in data.items():
            escaped_key = key if re.match(r'^[a-zA-Z_][a-zA-Z_0-9]*$', key) else f'`{key}`'
            field_path = f"{prefix}.{escaped_key}" if prefix else escaped_key

            if value == SERVER_TIMESTAMP:
                field_paths.append(field_path)
            elif isinstance(value, dict):
                nested_cleaned, nested_paths = self._extract_server_timestamps(value, field_path)
                if nested_cleaned:
                    cleaned[key] = nested_cleaned
                field_paths.extend(nested_paths)
            else:
                cleaned[key] = value

        return cleaned, field_paths

    def _build_field_transforms(self, field_paths: List[str]) -> List[Dict[str, str]]:
        """Build Firestore fieldTransforms for server timestamps."""
        return [
            {'fieldPath': path, 'setToServerValue': 'REQUEST_TIME'}
            for path in field_paths
        ]

    def _flatten_field_paths(self, data: Dict[str, Any], prefix: str = ""):
        """Yield all leaf field paths from a nested dict (for updateMask).
        Field names with special characters are backtick-escaped."""
        for key, value in data.items():
            escaped_key = key if re.match(r'^[a-zA-Z_][a-zA-Z_0-9]*$', key) else f'`{key}`'
            field_path = f"{prefix}.{escaped_key}" if prefix else escaped_key
            if isinstance(value, dict):
                yield from self._flatten_field_paths(value, field_path)
            else:
                yield field_path

    def _commit_write(self, path: str, cleaned_data: Dict[str, Any],
                      field_transforms: List[Dict[str, str]],
                      update_mask_paths: Optional[List[str]] = None):
        """
        Write a document via the :commit endpoint (supports fieldTransforms).

        Used instead of PATCH when SERVER_TIMESTAMP fields are present,
        since PATCH does not support updateTransforms.
        """
        url = f"{FIRESTORE_API_BASE}/projects/{self.project_id}/databases/(default)/documents:commit"
        doc_name = f"projects/{self.project_id}/databases/(default)/documents/{path}"

        write_entry = {
            'update': {
                'name': doc_name,
                **self._to_firestore_document(cleaned_data)
            },
            'updateTransforms': field_transforms
        }

        if update_mask_paths is not None:
            write_entry['updateMask'] = {'fieldPaths': update_mask_paths}

        response = self.session.post(
            url,
            json={'writes': [write_entry]},
            headers=self._get_auth_headers(),
            timeout=30
        )
        response.raise_for_status()

    def _from_firestore_document(self, firestore_doc: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert Firestore document to Python dict.

        Args:
            firestore_doc: Firestore document with 'fields' object

        Returns:
            Python dictionary
        """
        if 'fields' not in firestore_doc:
            return {}

        return {k: self._from_firestore_value(v) for k, v in firestore_doc['fields'].items()}

    def get_document(self, path: str, _suppress_logging: bool = False) -> Optional[Dict[str, Any]]:
        """
        Get a Firestore document.

        Args:
            path: Document path (e.g., 'sites/abc/machines/DESKTOP-001')
            _suppress_logging: If True, don't log errors (used by listener loops)

        Returns:
            Document data as dict, or None if not found
        """
        try:
            url = f"{self.base_url}/{path}"
            response = self.session.get(url, headers=self._get_auth_headers(), timeout=30)

            if response.status_code == 404:
                logger.debug(f"Document not found: {path}")
                return None

            response.raise_for_status()
            try:
                doc = response.json()
            except json.JSONDecodeError:
                logger.error(f"Non-JSON response for {path} (status {response.status_code}): {response.text[:200]}")
                raise
            return self._from_firestore_document(doc)

        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 404:
                return None
            if not _suppress_logging:
                logger.error(f"HTTP error getting document {path}: {e}")
            raise
        except Exception as e:
            # Check if this is a connectivity error
            error_str = str(e).lower()
            is_connectivity_error = any(x in error_str for x in [
                'connection', 'network', 'getaddrinfo', 'errno 11001',
                'unreachable', 'timeout', 'refused', 'max retries'
            ])

            if not _suppress_logging and not is_connectivity_error:
                # Only log non-connectivity errors at ERROR level
                logger.error(f"Error getting document {path}: {e}")
            elif not _suppress_logging:
                # Connectivity errors logged at DEBUG level (listener handles logging)
                logger.debug(f"Connectivity error getting document {path}: {type(e).__name__}")
            raise

    def set_document(self, path: str, data: Dict[str, Any], merge: bool = False):
        """
        Write a Firestore document.

        Args:
            path: Document path
            data: Document data as dict
            merge: If True, merge with existing data (default: False)
        """
        try:
            # Extract SERVER_TIMESTAMP fields for proper server-side timestamps
            cleaned_data, timestamp_paths = self._extract_server_timestamps(data)

            if timestamp_paths:
                # Use :commit endpoint (supports fieldTransforms for server timestamps)
                field_transforms = self._build_field_transforms(timestamp_paths)

                if merge:
                    # For merge, specify updateMask with all field paths to avoid overwriting
                    all_paths = list(self._flatten_field_paths(cleaned_data)) + timestamp_paths
                    self._commit_write(path, cleaned_data, field_transforms,
                                       update_mask_paths=all_paths)
                else:
                    self._commit_write(path, cleaned_data, field_transforms)
            else:
                # No server timestamps — use PATCH endpoint.
                #
                # CRITICAL: when merge=True, we MUST include updateMask in the
                # request, otherwise PATCH treats the request as a full
                # document replacement and DELETES every field not in the
                # payload (per Firestore REST API spec). Without this,
                # set_machine_flag/set_machine_flags would silently nuke
                # online, lastHeartbeat, metrics, etc. on every call —
                # which manifested as a 5-second offline window on the
                # dashboard until the next _upload_metrics restored them.
                url = f"{self.base_url}/{path}"
                firestore_doc = self._to_firestore_document(cleaned_data)

                params = None
                if merge:
                    # Build updateMask from all leaf field paths in the payload.
                    # This tells Firestore to only update these specific fields
                    # and leave everything else in the document untouched.
                    update_mask_paths = list(self._flatten_field_paths(cleaned_data))
                    params = [('updateMask.fieldPaths', p) for p in update_mask_paths]

                response = self.session.patch(
                    url,
                    json=firestore_doc,
                    params=params,
                    headers=self._get_auth_headers(),
                    timeout=30
                )

                response.raise_for_status()

            logger.debug(f"Document written: {path}")

        except Exception as e:
            logger.error(f"Error setting document {path}: {e}")
            raise

    def _escape_field_path(self, field_path: str) -> str:
        """
        Escape field path for Firestore REST API updateMask.

        Field names containing special characters (anything other than
        alphanumeric and underscore) must be enclosed in backticks.

        Args:
            field_path: Field path (may contain dots for nested fields)

        Returns:
            Escaped field path
        """
        # Split on dots for nested paths
        parts = field_path.split('.')
        escaped_parts = []

        for part in parts:
            # Check if part contains special characters (not alphanumeric or underscore)
            if re.search(r'[^a-zA-Z0-9_]', part):
                # Wrap in backticks
                escaped_parts.append(f'`{part}`')
            else:
                escaped_parts.append(part)

        return '.'.join(escaped_parts)

    def update_document(self, path: str, updates: Dict[str, Any]):
        """
        Update specific fields in a document.

        Supports nested field paths like 'metrics.cpu' or 'metrics.processes'.
        Supports DELETE_FIELD to remove fields from documents.

        Args:
            path: Document path
            updates: Fields to update (supports dot notation for nested fields)
        """
        try:
            # Extract SERVER_TIMESTAMP fields for proper server-side timestamps
            cleaned_updates, timestamp_paths = self._extract_server_timestamps(updates)

            # Build updateMask from ALL original keys (including timestamp fields)
            update_mask_paths = [self._escape_field_path(key) for key in updates.keys()]

            # Convert cleaned updates to Firestore format, handling nested paths
            firestore_fields = {}
            for key, value in cleaned_updates.items():
                firestore_value = self._to_firestore_value(value)

                # If _to_firestore_value returns None, it's a DELETE_FIELD sentinel
                # Include in updateMask but not in fields (this deletes the field)
                if firestore_value is None:
                    continue

                # Handle nested paths like 'metrics.cpu'
                if '.' in key:
                    # For nested updates, we need to construct the nested structure
                    parts = key.split('.')
                    current = firestore_fields

                    for i, part in enumerate(parts[:-1]):
                        if part not in current:
                            current[part] = {'mapValue': {'fields': {}}}
                        current = current[part]['mapValue']['fields']

                    # Set the final value
                    current[parts[-1]] = firestore_value
                else:
                    # Top-level field
                    firestore_fields[key] = firestore_value

            if timestamp_paths:
                # Use :commit endpoint (supports fieldTransforms for server timestamps)
                field_transforms = self._build_field_transforms(timestamp_paths)
                url = f"{FIRESTORE_API_BASE}/projects/{self.project_id}/databases/(default)/documents:commit"
                doc_name = f"projects/{self.project_id}/databases/(default)/documents/{path}"

                write_entry = {
                    'update': {
                        'name': doc_name,
                        'fields': firestore_fields
                    },
                    'updateTransforms': field_transforms,
                    'updateMask': {'fieldPaths': update_mask_paths}
                }

                response = self.session.post(
                    url,
                    json={'writes': [write_entry]},
                    headers=self._get_auth_headers(),
                    timeout=30
                )
            else:
                # No server timestamps — use existing PATCH logic
                url = f"{self.base_url}/{path}"
                params = {
                    'updateMask.fieldPaths': update_mask_paths
                }

                response = self.session.patch(
                    url,
                    json={'fields': firestore_fields},
                    params=params,
                    headers=self._get_auth_headers(),
                    timeout=30
                )

            response.raise_for_status()
            logger.debug(f"Document updated: {path}")

        except Exception as e:
            logger.error(f"Error updating document {path}: {e}")
            raise

    def delete_document(self, path: str):
        """
        Delete a Firestore document.

        Args:
            path: Document path
        """
        try:
            url = f"{self.base_url}/{path}"
            response = self.session.delete(url, headers=self._get_auth_headers(), timeout=30)

            # 404 is OK for delete (already doesn't exist)
            if response.status_code not in [200, 204, 404]:
                response.raise_for_status()

            logger.debug(f"Document deleted: {path}")

        except Exception as e:
            logger.error(f"Error deleting document {path}: {e}")
            raise

    def listen_to_document(
        self,
        path: str,
        callback: Callable[[Optional[Dict[str, Any]]], None],
        min_interval: float = 2.0,
        max_interval: float = 30.0,
        backoff_multiplier: float = 1.5
    ) -> tuple:
        """
        Listen to document changes in real-time using adaptive polling.

        Uses exponential backoff: starts at min_interval polling, increases to
        max_interval when idle. Configurable per-listener for different responsiveness needs.

        Args:
            path: Document path to listen to
            callback: Function to call when document changes (receives doc data)
            min_interval: Minimum polling interval in seconds (default: 2.0)
            max_interval: Maximum polling interval in seconds (default: 30.0)
            backoff_multiplier: Multiplier for interval increase when idle (default: 1.5)

        Returns:
            (thread, wake_event, stop_event) — thread is already started; set wake_event to
            interrupt the backoff sleep and force an immediate poll; set stop_event to
            terminate the polling loop.
        """
        wake_event = threading.Event()
        stop_event = threading.Event()

        def poll_document():
            """Poll document for changes with exponential backoff."""
            # Use a sentinel value to detect first run (different from None which means "document doesn't exist")
            _UNINITIALIZED = object()
            last_data = _UNINITIALIZED
            last_hash = None

            # Adaptive polling parameters (configured per-listener)
            current_interval = min_interval

            # Error tracking for reduced logging
            consecutive_errors = 0
            last_error_type = None

            while not stop_event.is_set():
                try:
                    # Get current document (suppress logging - we handle it here)
                    current_data = self.get_document(path, _suppress_logging=True)

                    # Success - reset error tracking
                    if consecutive_errors > 0:
                        logger.info(f"Listener recovered for {path} after {consecutive_errors} errors")
                    consecutive_errors = 0
                    last_error_type = None

                    # Calculate hash for reliable comparison (handles dict ordering, float precision, etc.)
                    if current_data is not None:
                        current_hash = hashlib.md5(json.dumps(current_data, sort_keys=True).encode()).hexdigest()
                    else:
                        current_hash = None

                    # Check if changed using hash comparison (more reliable than dict comparison)
                    if current_hash != last_hash:
                        # Document changed - reset to fast polling
                        current_interval = min_interval

                        # Skip callback on first run if document doesn't exist
                        if last_data is not _UNINITIALIZED or current_data is not None:
                            logger.debug(f"Document changed: {path}")
                            callback(current_data)
                        last_data = current_data
                        last_hash = current_hash
                    else:
                        # No change - increase interval (exponential backoff)
                        current_interval = min(current_interval * backoff_multiplier, max_interval)

                    # Poll with current interval (wake_event.set() interrupts immediately)
                    logger.debug(f"Polling {path} - next check in {current_interval:.1f}s")
                    if stop_event.is_set():
                        break
                    if wake_event.wait(current_interval):
                        # Woken up externally — reset to fast polling
                        wake_event.clear()
                        current_interval = min_interval

                except Exception as e:
                    if stop_event.is_set():
                        break
                    consecutive_errors += 1
                    error_type = type(e).__name__

                    # Determine if this is a connectivity error (should be logged less aggressively)
                    error_str = str(e).lower()
                    is_connectivity_error = any(x in error_str for x in [
                        'connection', 'network', 'getaddrinfo', 'errno 11001',
                        'unreachable', 'timeout', 'refused'
                    ])

                    # Log strategy: first error, then every 30th, or when error type changes
                    should_log = (
                        consecutive_errors == 1 or
                        error_type != last_error_type or
                        consecutive_errors % 30 == 0
                    )

                    if should_log:
                        if is_connectivity_error:
                            # Connectivity errors: minimal logging
                            if consecutive_errors == 1:
                                logger.warning(f"Listener lost connectivity for {path}: {error_type}")
                            else:
                                logger.debug(f"Listener still offline for {path} ({consecutive_errors} errors)")
                        else:
                            # Other errors: normal logging
                            logger.error(f"Error in document listener for {path}: {e}")

                    last_error_type = error_type

                    # Back off on error - interruptible via stop_event
                    error_backoff = min(5 * (1 + consecutive_errors // 10), 60)  # 5s to 60s max
                    stop_event.wait(error_backoff)
                    current_interval = min_interval  # Reset interval after error

            logger.debug(f"Listener stopped for document: {path}")

        thread = threading.Thread(target=poll_document, daemon=True)
        thread.start()
        logger.debug(f"Started listener for document: {path}")
        return thread, wake_event, stop_event

    def batch_write(self, writes: List[Dict[str, Any]]):
        """
        Perform batch write operation.

        Args:
            writes: List of write operations, each with:
                - operation: 'set', 'update', or 'delete'
                - path: Document path
                - data: Document data (for set/update)

        Example:
            client.batch_write([
                {'operation': 'set', 'path': 'logs/log1', 'data': {'msg': 'test'}},
                {'operation': 'delete', 'path': 'logs/log2'},
            ])
        """
        try:
            # Firestore REST API batch write endpoint
            url = f"{FIRESTORE_API_BASE}/projects/{self.project_id}/databases/(default)/documents:batchWrite"

            # Build batch write request
            batch_writes = []

            for write in writes:
                operation = write.get('operation')
                path = write.get('path')
                data = write.get('data', {})

                doc_name = f"projects/{self.project_id}/databases/(default)/documents/{path}"

                if operation == 'set':
                    # Extract SERVER_TIMESTAMP fields for proper server-side timestamps
                    cleaned_data, timestamp_paths = self._extract_server_timestamps(data)
                    write_entry = {
                        'update': {
                            'name': doc_name,
                            **self._to_firestore_document(cleaned_data)
                        }
                    }
                    if timestamp_paths:
                        write_entry['updateTransforms'] = self._build_field_transforms(timestamp_paths)
                    batch_writes.append(write_entry)
                elif operation == 'delete':
                    batch_writes.append({
                        'delete': doc_name
                    })
                elif operation == 'update':
                    # Extract SERVER_TIMESTAMP fields for proper server-side timestamps
                    cleaned_data, timestamp_paths = self._extract_server_timestamps(data)
                    write_entry = {
                        'update': {
                            'name': doc_name,
                            **self._to_firestore_document(cleaned_data)
                        },
                        'updateMask': {
                            'fieldPaths': list(data.keys())
                        }
                    }
                    if timestamp_paths:
                        write_entry['updateTransforms'] = self._build_field_transforms(timestamp_paths)
                    batch_writes.append(write_entry)

            # Execute batch write
            response = self.session.post(
                url,
                json={'writes': batch_writes},
                headers=self._get_auth_headers(),
                timeout=30
            )

            response.raise_for_status()
            logger.debug(f"Batch write completed: {len(writes)} operations")

        except Exception as e:
            # Check if this is a 403 Forbidden error (expected with OAuth tokens)
            is_403 = hasattr(e, 'response') and e.response is not None and e.response.status_code == 403

            if is_403:
                # 403 errors on batch writes are expected with OAuth tokens - log at DEBUG level
                logger.debug(f"Batch write forbidden (expected with OAuth tokens): {e}")
                if hasattr(e, 'response'):
                    try:
                        error_details = e.response.json()
                        logger.debug(f"Firestore error details: {error_details}")
                    except (json.JSONDecodeError, ValueError):
                        pass
            else:
                # Log other errors at ERROR level
                logger.error(f"Error in batch write: {e}")
                # Log response body for debugging (may contain security rule details)
                if hasattr(e, 'response') and e.response is not None:
                    try:
                        error_details = e.response.json()
                        logger.error(f"Firestore error details: {error_details}")
                    except (json.JSONDecodeError, ValueError):
                        logger.error(f"Response text: {e.response.text if hasattr(e.response, 'text') else 'N/A'}")
            raise

    def collection(self, path: str):
        """
        Get a collection reference (for SDK-like interface).

        Returns a CollectionReference object that supports .document() chaining.

        Args:
            path: Collection path (e.g., 'sites')

        Returns:
            CollectionReference object
        """
        return CollectionReference(self, path)

    def batch(self):
        """
        Create a batch writer for atomic operations.

        Returns:
            BatchWriter object
        """
        return BatchWriter(self)


class CollectionReference:
    """
    Collection reference for SDK-like interface.

    Allows chaining like: firestore.collection('sites').document('abc').collection('machines')
    """

    def __init__(self, client: FirestoreRestClient, path: str):
        self.client = client
        self.path = path

    def document(self, doc_id: str):
        """Get a document reference."""
        return DocumentReference(self.client, f"{self.path}/{doc_id}")

    def stream(self):
        """
        Stream all documents in the collection.

        Note: This fetches all documents at once (no true streaming).
        For large collections, this may be slow or hit memory limits.

        Returns:
            Generator of DocumentSnapshot objects
        """
        try:
            # Firestore REST API list documents endpoint
            url = f"{self.client.base_url}/{self.path}"

            response = self.client.session.get(
                url,
                headers=self.client._get_auth_headers(),
                timeout=30
            )

            response.raise_for_status()
            try:
                data = response.json()
            except json.JSONDecodeError:
                logger.error(f"Non-JSON response listing documents (status {response.status_code}): {response.text[:200]}")
                return

            # Parse documents from response
            documents = data.get('documents', [])

            for doc in documents:
                # Extract document ID from name
                # Format: projects/.../databases/.../documents/path/to/doc_id
                doc_name = doc.get('name', '')
                doc_id = doc_name.split('/')[-1]

                # Create DocumentSnapshot-like object
                yield DocumentSnapshot(
                    reference=DocumentReference(self.client, f"{self.path}/{doc_id}"),
                    data=self.client._from_firestore_document(doc),
                    exists=True
                )

        except Exception as e:
            logger.error(f"Error streaming collection {self.path}: {e}")
            raise


class DocumentReference:
    """
    Document reference for SDK-like interface.

    Provides methods: get(), set(), update(), delete(), collection()
    """

    def __init__(self, client: FirestoreRestClient, path: str):
        self.client = client
        self.path = path

    def get(self) -> Optional[Dict[str, Any]]:
        """Get document data."""
        return self.client.get_document(self.path)

    def set(self, data: Dict[str, Any], merge: bool = False):
        """Set document data."""
        return self.client.set_document(self.path, data, merge=merge)

    def update(self, updates: Dict[str, Any]):
        """Update document fields."""
        return self.client.update_document(self.path, updates)

    def delete(self):
        """Delete document."""
        return self.client.delete_document(self.path)

    def collection(self, collection_id: str):
        """Get a subcollection reference."""
        return CollectionReference(self.client, f"{self.path}/{collection_id}")


class DocumentSnapshot:
    """
    Document snapshot returned by stream() operations.

    Matches the interface of firebase_admin DocumentSnapshot.
    """

    def __init__(self, reference: DocumentReference, data: Optional[Dict[str, Any]], exists: bool):
        self.reference = reference
        self._data = data
        self.exists = exists

    def to_dict(self) -> Optional[Dict[str, Any]]:
        """Get document data as dictionary."""
        return self._data


class BatchWriter:
    """
    Batch writer for atomic operations.

    Matches the interface of firebase_admin WriteBatch.
    """

    def __init__(self, client: FirestoreRestClient):
        self.client = client
        self.operations: List[Dict[str, Any]] = []

    def set(self, reference: DocumentReference, data: Dict[str, Any]):
        """Add a set operation to the batch."""
        self.operations.append({
            'operation': 'set',
            'path': reference.path,
            'data': data
        })
        return self

    def update(self, reference: DocumentReference, updates: Dict[str, Any]):
        """Add an update operation to the batch."""
        self.operations.append({
            'operation': 'update',
            'path': reference.path,
            'data': updates
        })
        return self

    def delete(self, reference: DocumentReference):
        """Add a delete operation to the batch."""
        self.operations.append({
            'operation': 'delete',
            'path': reference.path
        })
        return self

    def commit(self):
        """Commit all batched operations atomically."""
        if not self.operations:
            return

        # Use the existing batch_write method
        self.client.batch_write(self.operations)

        # Clear operations after commit
        self.operations = []


# Example usage
if __name__ == "__main__":
    # Configure logging for testing
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    # Example: Initialize client
    from auth_manager import AuthManager

    auth = AuthManager(api_base="https://dev.owlette.app/api")
    firestore = FirestoreRestClient(project_id="owlette-dev-3838a", auth_manager=auth)

    # Example: Set document
    firestore.set_document('test/doc1', {
        'name': 'Test',
        'count': 42,
        'active': True,
        'timestamp': SERVER_TIMESTAMP
    })

    # Example: Get document
    data = firestore.get_document('test/doc1')
    print(f"Document data: {data}")

    # Example: Update document
    firestore.update_document('test/doc1', {
        'count': 43,
        'nested.field': 'value'
    })

    # Example: SDK-like interface
    doc_ref = firestore.collection('sites').document('abc').collection('machines').document('DESKTOP-001')
    doc_ref.set({'online': True}, merge=True)

    # Example: Listen to document
    def on_change(data):
        print(f"Config changed: {data}")

    listener_thread = firestore.listen_to_document('config/abc/machines/DESKTOP-001', on_change)
