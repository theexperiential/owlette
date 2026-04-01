"""
Firestore message bridge for Owlette Cortex.

Handles polling for pending chat messages, progressive response writing,
heartbeat updates, cortex status, and autonomous event logging.

Uses the existing FirestoreRestClient (REST API, not firebase_admin).
"""

import logging
import time
from typing import Any, Dict, List, Optional

from firestore_rest_client import FirestoreRestClient, SERVER_TIMESTAMP

logger = logging.getLogger(__name__)

# Minimum interval between progressive response writes (seconds)
CHUNK_WRITE_INTERVAL = 0.5


class CortexFirestore:
    """Bridge between local Cortex process and Firestore."""

    def __init__(self, db: FirestoreRestClient, site_id: str, machine_id: str):
        """
        Args:
            db: Initialized FirestoreRestClient instance.
            site_id: Firebase site ID this machine belongs to.
            machine_id: Machine identifier (hostname).
        """
        self.db = db
        self.site_id = site_id
        self.machine_id = machine_id
        self._last_chunk_write = 0.0

    # ─── Path Helpers ─────────────────────────────────────────────────────

    @property
    def _machine_path(self) -> str:
        return f"sites/{self.site_id}/machines/{self.machine_id}"

    @property
    def _active_chat_path(self) -> str:
        return f"{self._machine_path}/cortex/active-chat"

    @property
    def _cortex_events_path(self) -> str:
        return f"sites/{self.site_id}/cortex-events"

    # ─── User Chat ────────────────────────────────────────────────────────

    def poll_for_messages(self) -> Optional[Dict[str, Any]]:
        """Check active-chat doc for a pending message.

        Returns:
            Message dict with 'content', 'chatId', 'messages' if pending,
            or None if no pending message.
        """
        try:
            doc = self.db.get_document(self._active_chat_path, _suppress_logging=True)
            if not doc:
                return None

            if doc.get('status') != 'pending':
                return None

            result: Dict[str, Any] = {
                'content': doc.get('pendingMessage', ''),
                'chatId': doc.get('chatId', ''),
                'messages': doc.get('messages', []),
                'machineName': doc.get('machineName', self.machine_id),
            }
            # Include image URLs if present (pasted screenshots from web UI)
            images = doc.get('images')
            if images:
                result['images'] = images
            return result
        except Exception as e:
            logger.debug(f"Error polling for messages: {e}")
            return None

    def set_status(self, status: str):
        """Update the active-chat status field.

        Args:
            status: One of 'pending', 'processing', 'streaming', 'complete', 'error'.
        """
        try:
            self.db.update_document(self._active_chat_path, {
                'status': status,
                'updatedAt': SERVER_TIMESTAMP,
            })
        except Exception as e:
            logger.warning(f"Failed to set chat status to '{status}': {e}")

    def write_response_chunk(self, content: str, parts: Optional[List[Dict]] = None):
        """Write a progressive response chunk to Firestore.

        Throttled to ~500ms between writes to limit Firestore costs.

        Args:
            content: Full response content so far (not a delta).
            parts: Optional UIMessage parts array for tool call rendering.
        """
        now = time.time()
        if now - self._last_chunk_write < CHUNK_WRITE_INTERVAL:
            return

        try:
            update: Dict[str, Any] = {
                'response.content': content,
                'response.complete': False,
                'status': 'streaming',
                'updatedAt': SERVER_TIMESTAMP,
            }
            if parts is not None:
                update['response.parts'] = parts

            self.db.update_document(self._active_chat_path, update)
            self._last_chunk_write = now
        except Exception as e:
            logger.debug(f"Failed to write response chunk: {e}")

    def write_final_response(
        self,
        content: str,
        parts: Optional[List[Dict]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        """Write the final (complete) response to Firestore.

        Args:
            content: Full response text.
            parts: UIMessage parts array.
            metadata: Optional metadata (model, usage, duration).
        """
        try:
            update: Dict[str, Any] = {
                'response.content': content,
                'response.complete': True,
                'status': 'complete',
                'updatedAt': SERVER_TIMESTAMP,
            }
            if parts is not None:
                update['response.parts'] = parts
            if metadata:
                update['response.metadata'] = metadata

            self.db.update_document(self._active_chat_path, update)
            self._last_chunk_write = 0.0  # Reset throttle
            logger.debug("Final response written to Firestore")
        except Exception as e:
            logger.error(f"Failed to write final response: {e}")

    def write_error_response(self, error_message: str):
        """Write an error status to the active-chat doc."""
        try:
            self.db.update_document(self._active_chat_path, {
                'status': 'error',
                'response.content': f"Error: {error_message}",
                'response.complete': True,
                'updatedAt': SERVER_TIMESTAMP,
            })
        except Exception as e:
            logger.error(f"Failed to write error response: {e}")

    # ─── Heartbeat & Status ───────────────────────────────────────────────

    def write_cortex_heartbeat(self):
        """Update the Cortex heartbeat timestamp on the machine doc."""
        try:
            self.db.update_document(self._machine_path, {
                'cortexStatus.lastHeartbeat': SERVER_TIMESTAMP,
                'cortexStatus.online': True,
            })
        except Exception as e:
            logger.debug(f"Failed to write heartbeat: {e}")

    def write_cortex_status(self, status: str):
        """Update the Cortex status (idle, thinking, tool_call, error).

        Args:
            status: Current cortex status string.
        """
        try:
            self.db.update_document(self._machine_path, {
                'cortexStatus.status': status,
                'cortexStatus.lastHeartbeat': SERVER_TIMESTAMP,
                'cortexStatus.online': True,
            })
        except Exception as e:
            logger.debug(f"Failed to write cortex status: {e}")

    def write_cortex_offline(self):
        """Mark Cortex as offline on the machine doc."""
        try:
            self.db.update_document(self._machine_path, {
                'cortexStatus.online': False,
                'cortexStatus.status': 'offline',
                'cortexStatus.lastHeartbeat': SERVER_TIMESTAMP,
            })
            logger.info("Cortex marked offline in Firestore")
        except Exception as e:
            logger.warning(f"Failed to mark Cortex offline: {e}")

    # ─── Autonomous Events ────────────────────────────────────────────────

    def write_autonomous_event(self, event_id: str, data: Dict[str, Any]):
        """Write an autonomous investigation result to cortex-events collection.

        Args:
            event_id: Unique event identifier.
            data: Event data dict matching the cortex-events schema.
        """
        try:
            doc_path = f"{self._cortex_events_path}/{event_id}"
            event_data = {
                **data,
                'machineId': self.machine_id,
                'timestamp': SERVER_TIMESTAMP,
                'source': 'local',
            }
            self.db.set_document(doc_path, event_data)
            logger.info(f"Autonomous event written: {event_id}")
        except Exception as e:
            logger.error(f"Failed to write autonomous event {event_id}: {e}")

    def write_escalation_flag(self, event_id: str):
        """Flag an autonomous event for web-side escalation (email).

        Args:
            event_id: The event to flag.
        """
        try:
            doc_path = f"{self._cortex_events_path}/{event_id}"
            self.db.update_document(doc_path, {
                'status': 'escalated',
                'escalationPending': True,
                'escalatedAt': SERVER_TIMESTAMP,
            })
            logger.info(f"Escalation flag set for event: {event_id}")
        except Exception as e:
            logger.error(f"Failed to set escalation flag for {event_id}: {e}")
