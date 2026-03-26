"""
Firebase Client for Owlette 2.0

Handles all Firestore operations including:
- Machine presence/heartbeat
- Configuration sync with offline caching
- Command queue (bidirectional communication)
- System metrics reporting
- Offline resilience

OAuth Authentication:
This version uses custom token authentication via REST API instead of
service account credentials, eliminating the need for firebase-credentials.json.

Connection Management:
Uses centralized ConnectionManager for robust reconnection handling with:
- State machine (DISCONNECTED -> CONNECTING -> CONNECTED)
- Circuit breaker pattern
- Exponential backoff with jitter
- Thread supervision and watchdog
"""

import queue
import threading
import time
import json
import os
import logging
import socket
import hashlib
from typing import Dict, Any, Callable, Optional
from datetime import datetime

# Import shared utilities
import shared_utils
import registry_utils

# Import new OAuth-based modules (replace firebase_admin)
from auth_manager import AuthManager, AuthenticationError, TokenRefreshError
from firestore_rest_client import FirestoreRestClient, SERVER_TIMESTAMP, DELETE_FIELD

# Import centralized connection manager
from connection_manager import ConnectionManager, ConnectionState, ConnectionEvent


class FirebaseClient:
    """
    Main Firebase client for Owlette agent.
    Handles all cloud communication with offline resilience.

    Uses ConnectionManager for centralized connection state management,
    ensuring robust reconnection handling for all failure scenarios.
    """

    def __init__(self, auth_manager: AuthManager, project_id: str, site_id: str, config_cache_path: str = "config/firebase_cache.json"):
        """
        Initialize Firebase client with OAuth authentication.

        Args:
            auth_manager: AuthManager instance for token management
            project_id: Firebase project ID (e.g., "owlette-dev-3838a")
            site_id: Site ID this machine belongs to
            config_cache_path: Path to store cached config for offline mode
        """
        self.auth_manager = auth_manager
        self.project_id = project_id
        self.site_id = site_id
        self.machine_id = socket.gethostname()
        self.config_cache_path = config_cache_path

        # Firestore REST client instance
        self.db: Optional[FirestoreRestClient] = None

        # Logging
        self.logger = logging.getLogger("OwletteFirebase")

        # =================================================================
        # Connection Manager (centralized state management)
        # =================================================================
        self.connection_manager = ConnectionManager(self.logger)

        # Register callbacks with connection manager
        self.connection_manager.set_callbacks(
            connect=self._do_connect,
            disconnect=self._do_disconnect,
            on_connected=self._on_connected
        )

        # Register thread factories for supervision
        self.connection_manager.register_thread(
            "command_listener",
            self._create_command_listener_thread
        )
        self.connection_manager.register_thread(
            "config_listener",
            self._create_config_listener_thread
        )

        # Listen for state changes
        self.connection_manager.add_state_listener(self._on_connection_state_change)

        # =================================================================
        # Thread references (managed by ConnectionManager)
        # =================================================================
        self.metrics_thread: Optional[threading.Thread] = None
        self.running = False

        # =================================================================
        # Callbacks
        # =================================================================
        self.command_callback: Optional[Callable] = None
        self.config_update_callback: Optional[Callable] = None

        # =================================================================
        # Slow-command queue (installs, uninstalls, updates — serialised)
        # =================================================================
        self._slow_command_queue: queue.Queue = queue.Queue()
        self._slow_command_worker = threading.Thread(
            target=self._slow_command_worker_loop,
            name="slow-cmd-worker",
            daemon=True,
        )
        self._slow_command_worker.start()

        # =================================================================
        # Cached config for offline mode
        # =================================================================
        self.cached_config: Optional[Dict] = None

        # Track last uploaded config to prevent processing our own writes
        self._last_uploaded_config_hash: Optional[str] = None

        # Cached site timezone (fetched from sites/{siteId} on connect)
        self.site_timezone: Optional[str] = None

        # Track last synced software inventory hash to prevent unnecessary writes
        self._last_software_inventory_hash: Optional[str] = None

        # =================================================================
        # Initialize Firebase connection
        # =================================================================
        self._load_cached_config()
        self.connection_manager.connect()

    # =========================================================================
    # Connection Manager Callbacks
    # =========================================================================

    def _do_connect(self) -> bool:
        """
        Called by ConnectionManager to establish connection.

        Returns:
            True if connection succeeded, False otherwise.
        """
        try:
            # Check if authenticated
            if not self.auth_manager.is_authenticated():
                self.logger.error("Agent not authenticated - no refresh token found")
                self.logger.warning("Running in OFFLINE MODE - will use cached config only")
                return False

            # Validate token before creating client
            try:
                self.auth_manager.get_valid_token()
            except (AuthenticationError, TokenRefreshError) as e:
                self.logger.error(f"Token validation failed: {e}")
                return False

            # Initialize Firestore REST client
            self.db = FirestoreRestClient(
                project_id=self.project_id,
                auth_manager=self.auth_manager
            )

            self.logger.info(f"Firestore initialized - Site: {self.site_id}, Machine: {self.machine_id}")
            return True

        except Exception as e:
            self.logger.error(f"Failed to initialize Firebase: {e}")
            return False

    def _do_disconnect(self):
        """
        Called by ConnectionManager during shutdown.
        Performs cleanup operations.
        """
        self.logger.debug("Disconnect callback: cleaning up resources")
        # Firestore REST client doesn't need explicit cleanup
        # but we could add cleanup here if needed

    def _on_connected(self):
        """
        Called by ConnectionManager after successful connection/reconnection.
        Performs initial data sync.
        """
        if not self.running:
            return  # Don't send data if not started

        try:
            # Fetch site timezone for schedule evaluation
            self._fetch_site_timezone()

            # Send immediate heartbeat and metrics
            self._update_presence(True)
            self.logger.debug("Heartbeat sent after connection")

            metrics = shared_utils.get_system_metrics()
            self._upload_metrics(metrics)
            self.logger.debug("Initial metrics uploaded after connection")
        except Exception as e:
            self.logger.error(f"Failed to send initial data after connection: {e}")
            # Report error but don't fail - connection is still valid
            self.connection_manager.report_error(e, "Initial data upload")

    def _on_connection_state_change(self, event: ConnectionEvent):
        """
        React to connection state changes.

        Args:
            event: ConnectionEvent with old_state, new_state, reason
        """
        if event.new_state == ConnectionState.FATAL_ERROR:
            # Machine may have been removed from site
            self._handle_fatal_error(event.reason)

    def _handle_fatal_error(self, reason: str):
        """
        Handle fatal connection errors (e.g., machine removed from site).

        Args:
            reason: Reason for the fatal error
        """
        self.logger.error(f"Fatal connection error: {reason}")

        # Check if this looks like a removal
        reason_lower = reason.lower()
        if any(x in reason_lower for x in ['403', '404', 'permission', 'not found']):
            self.logger.warning("Machine may have been removed from site via web dashboard")
            self.logger.info("Disabling Firebase and clearing site_id in local config")

            try:
                # Load current config
                config = shared_utils.read_config()

                # Disable Firebase and clear site_id
                if 'firebase' not in config:
                    config['firebase'] = {}

                config['firebase']['enabled'] = False
                config['firebase']['site_id'] = ''

                # Save config
                shared_utils.save_config(config)
                self.logger.info("Local config updated - machine deregistered from site")

            except Exception as config_error:
                self.logger.error(f"Failed to update local config after removal detection: {config_error}")

    # =========================================================================
    # Thread Factories (for ConnectionManager supervision)
    # =========================================================================

    def _create_command_listener_thread(self) -> threading.Thread:
        """Factory for creating command listener thread."""
        return threading.Thread(target=self._command_listener_loop, daemon=True)

    def _create_config_listener_thread(self) -> threading.Thread:
        """Factory for creating config listener thread."""
        return threading.Thread(target=self._config_listener_loop, daemon=True)

    # =========================================================================
    # Site Metadata
    # =========================================================================

    def _fetch_site_timezone(self):
        """Fetch and cache the site timezone from Firestore."""
        try:
            if not self.db:
                return
            site_doc = self.db.get_document(f"sites/{self.site_id}")
            if site_doc:
                self.site_timezone = site_doc.get('timezone') or None
                if self.site_timezone:
                    self.logger.info(f"Site timezone: {self.site_timezone}")
        except Exception as e:
            self.logger.debug(f"Could not fetch site timezone: {e}")

    # =========================================================================
    # Public Properties
    # =========================================================================

    @property
    def connected(self) -> bool:
        """Check if connected to Firestore (via ConnectionManager)."""
        return self.connection_manager.is_connected

    def is_connected(self) -> bool:
        """Check if connected to Firestore."""
        return self.connection_manager.is_connected

    def get_machine_id(self) -> str:
        """Get the machine ID (hostname)."""
        return self.machine_id

    def get_site_id(self) -> str:
        """Get the site ID."""
        return self.site_id

    # =========================================================================
    # Lifecycle Methods
    # =========================================================================

    def start(self):
        """Start all background threads (metrics, command listener, config listener)."""
        if self.running:
            self.logger.warning("Firebase client already running")
            return

        self.running = True

        # Start watchdog for thread supervision
        self.connection_manager.start_watchdog()

        # Send immediate heartbeat and metrics if connected
        if self.connected:
            try:
                self._update_presence(True)
                self.logger.info("Initial heartbeat sent - machine is now online")

                metrics = shared_utils.get_system_metrics()
                self._upload_metrics(metrics)
                self.logger.debug("Initial metrics uploaded")

                # Report success to reset any failure counters
                self.connection_manager.report_success()
            except Exception as e:
                self.logger.error(f"Failed to send initial heartbeat/metrics: {e}")
                self.connection_manager.report_error(e, "Initial heartbeat/metrics")

        self.logger.debug("Heartbeat thread DISABLED - heartbeat data included in metrics")

        # Start metrics thread (main loop with reconnection logic)
        self.metrics_thread = threading.Thread(target=self._metrics_loop, daemon=True)
        self.metrics_thread.start()
        self.logger.debug("Metrics thread started")

        # Start listeners if connected (ConnectionManager will supervise these)
        if self.connected:
            # Trigger initial thread start via connection manager
            self.connection_manager._restart_all_threads()
            self.logger.debug("Listener threads started (supervised by ConnectionManager)")

            # Sync software inventory once on startup (in background — can be slow)
            def _sync_inventory_bg():
                try:
                    self._sync_software_inventory(force=True)
                    self.logger.info("Initial software inventory synced to Firestore")
                except Exception as e:
                    self.logger.error(f"Failed to sync initial software inventory: {e}")
            threading.Thread(target=_sync_inventory_bg, daemon=True, name="InventorySync").start()
        else:
            self.logger.warning("Listener threads NOT started (offline mode)")
            self.logger.warning("Software inventory NOT synced (offline mode)")

    def stop(self):
        """Stop all background threads and set machine offline."""
        self.logger.info("Stopping Firebase client and setting machine offline...")

        # Set machine as offline BEFORE stopping threads (critical for clean shutdown)
        if self.connected and self.db:
            try:
                presence_ref = self.db.collection('sites').document(self.site_id)\
                    .collection('machines').document(self.machine_id)

                max_attempts = 3
                for attempt in range(max_attempts):
                    try:
                        presence_ref.set({
                            'online': False,
                            'lastHeartbeat': SERVER_TIMESTAMP,
                            'machineId': self.machine_id,
                            'siteId': self.site_id
                        }, merge=True)
                        self.logger.info(f"[OK] Machine marked OFFLINE in Firestore (attempt {attempt + 1}/{max_attempts})")
                        time.sleep(1)
                        break
                    except Exception as e:
                        if attempt == max_attempts - 1:
                            raise
                        self.logger.warning(f"Offline update attempt {attempt + 1} failed, retrying...")
                        time.sleep(0.2)

            except Exception as e:
                self.logger.error(f"[ERROR] Failed to set machine offline after {max_attempts} attempts: {e}")

        # Stop the background threads
        self.running = False

        # Shutdown connection manager (stops watchdog and supervised threads)
        self.connection_manager.shutdown()

        self.logger.info("Background threads stopped")

    # =========================================================================
    # Main Metrics Loop
    # =========================================================================

    def _metrics_loop(self):
        """
        Metrics loop - uploads system stats with intelligent adaptive intervals.

        This is the main loop that also handles reconnection via ConnectionManager.

        Intervals:
        - 5s when GUI is open (user actively monitoring)
        - 30s when processes are running (active monitoring)
        - 120s when idle (minimal overhead)
        """
        self.logger.debug("[THREAD] Metrics loop started")

        last_mode = None
        try:
            while self.running:
                interval = 60  # Default interval

                try:
                    if self.connected:
                        # Validate token before upload (may trigger refresh)
                        try:
                            self.auth_manager.get_valid_token()
                        except Exception as e:
                            self.logger.error(f"Token validation/refresh failed: {e}")
                            self.connection_manager.report_error(e, "Token validation")
                            time.sleep(60)
                            continue

                        # Upload metrics
                        metrics = shared_utils.get_system_metrics()
                        self._upload_metrics(metrics)

                        # Report success to connection manager
                        self.connection_manager.report_success()

                        # Adaptive interval based on activity
                        gui_running = shared_utils.is_script_running('owlette_gui.py')

                        if gui_running:
                            interval = 5
                            mode = 'GUI active'
                        else:
                            processes = metrics.get('processes', {})
                            any_process_running = any(
                                proc.get('status') == 'RUNNING'
                                for proc in processes.values()
                                if isinstance(proc, dict)
                            )

                            if any_process_running:
                                interval = 30
                                mode = 'processes active'
                            else:
                                interval = 120
                                mode = 'idle'

                        if mode != last_mode:
                            self.logger.info(f"Metrics interval changed to {interval}s ({mode})")
                            last_mode = mode
                        else:
                            self.logger.debug(f"Metrics uploaded - next in {interval}s ({mode})")

                    else:
                        # NOT CONNECTED - actively trigger reconnection attempt
                        state = self.connection_manager.state
                        reason = self.connection_manager.state_reason
                        self.logger.debug(f"[METRICS] Not connected (state={state.name}): {reason}")

                        # Trigger reconnection if not already in progress
                        if state == ConnectionState.DISCONNECTED:
                            self.logger.debug("[METRICS] Triggering reconnection attempt...")
                            self.connection_manager.force_reconnect("Metrics loop detected disconnect")

                        # Use shorter interval when disconnected
                        interval = 30

                except Exception as e:
                    self.logger.error(f"Metrics upload failed: {e}")
                    self.connection_manager.report_error(e, "Metrics upload")
                    interval = 60

                time.sleep(interval)

        except Exception as e:
            self.logger.error(f"[THREAD] Metrics loop CRASHED with unexpected error: {e}")
        finally:
            self.logger.error(f"[THREAD] Metrics loop EXITED (running={self.running})")

    # =========================================================================
    # Listener Loops
    # =========================================================================

    def _command_listener_loop(self):
        """Listen for commands from Firestore in real-time."""
        self.logger.debug("[THREAD] Command listener loop started")

        if not self.connected:
            self.logger.warning("[THREAD] Command listener exiting - not connected")
            return

        try:
            commands_path = f"sites/{self.site_id}/machines/{self.machine_id}/commands/pending"
            seen_commands: set = set()

            def on_commands_changed(commands_data):
                """Handle commands document changes, skipping already-processed commands."""
                if commands_data:
                    for cmd_id, cmd_data in commands_data.items():
                        if cmd_id in seen_commands:
                            continue
                        seen_commands.add(cmd_id)
                        self._process_command(cmd_id, cmd_data)

                    # Prune seen set: remove IDs no longer in pending doc
                    gone = seen_commands - set(commands_data.keys())
                    seen_commands.difference_update(gone)

            # Start listener with tight polling (2-5s) for fast command pickup
            self.db.listen_to_document(
                commands_path, on_commands_changed,
                min_interval=2.0, max_interval=5.0, backoff_multiplier=1.3
            )

            # Keep this thread alive while running and connected
            while self.running and self.connected:
                time.sleep(1)

        except Exception as e:
            self.logger.error(f"Command listener error: {e}")
            # Report error to connection manager for centralized handling
            self.connection_manager.report_error(e, "Command listener")
        finally:
            self.logger.debug(f"[THREAD] Command listener loop EXITED (running={self.running}, connected={self.connected})")

    def _config_listener_loop(self):
        """Listen for config changes from Firestore in real-time."""
        self.logger.debug("[THREAD] Config listener loop started")

        if not self.connected:
            self.logger.warning("[THREAD] Config listener exiting - not connected")
            return

        try:
            config_path = f"config/{self.site_id}/machines/{self.machine_id}"

            def on_config_changed(config_data):
                """Handle config document changes."""
                if config_data:
                    incoming_hash = hashlib.md5(json.dumps(config_data, sort_keys=True).encode()).hexdigest()

                    if incoming_hash == self._last_uploaded_config_hash:
                        self.logger.debug(f"Skipping self-originated config change (hash: {incoming_hash[:8]}...)")
                        return

                    self.logger.info(f"Config change detected in Firestore (hash: {incoming_hash[:8]}...)")

                    self._save_cached_config(config_data)
                    self.cached_config = config_data

                    if self.config_update_callback:
                        try:
                            self.config_update_callback(config_data)
                        except Exception as e:
                            self.logger.error(f"Error in config update callback: {e}")
                            import traceback
                            self.logger.error(f"Traceback: {traceback.format_exc()}")
                    else:
                        self.logger.warning("No config update callback registered")

            # Start listener with tight polling for fast config pickup
            self.db.listen_to_document(
                config_path, on_config_changed,
                min_interval=2.0, max_interval=10.0, backoff_multiplier=1.3
            )

            # Keep this thread alive while running and connected
            while self.running and self.connected:
                time.sleep(1)

        except Exception as e:
            self.logger.error(f"Config listener error: {e}")
            # Report error to connection manager for centralized handling
            self.connection_manager.report_error(e, "Config listener")
        finally:
            self.logger.debug(f"[THREAD] Config listener loop EXITED (running={self.running}, connected={self.connected})")

    # =========================================================================
    # Firestore Operations
    # =========================================================================

    def write_health_to_firestore(self, status: str, error_code, error_message):
        """
        Write agent health status to the Firestore machine document.

        Called when a health state change occurs (connection failure, recovery, etc.).
        Only executes when connected — callers should guard with is_connected() if needed.

        Args:
            status: Health status string ('ok', 'connection_failure', etc.)
            error_code: Short error code string, or None
            error_message: Human-readable message, or None
        """
        if not self.connected or not self.db:
            return
        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            machine_ref.set({
                'health': {
                    'status': status,
                    'error_code': error_code,
                    'error_message': error_message,
                    'last_checked_at': SERVER_TIMESTAMP,
                    'last_error_at': SERVER_TIMESTAMP if error_code else None,
                }
            }, merge=True)
            self.logger.debug(f"[HEALTH] Wrote health to Firestore: status={status}")
        except Exception as e:
            self.logger.debug(f"[HEALTH] Failed to write health to Firestore: {e}")

    def _update_presence(self, online: bool):
        """Update machine presence/heartbeat in Firestore."""
        if not self.connected or not self.db:
            return

        try:
            presence_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            presence_ref.set({
                'online': online,
                'lastHeartbeat': SERVER_TIMESTAMP,
                'machineId': self.machine_id,
                'siteId': self.site_id
            }, merge=True)

            if online:
                self.logger.debug("Heartbeat: Machine online")
            else:
                self.logger.info(f"[OK] Machine marked OFFLINE in Firestore (site: {self.site_id}, machine: {self.machine_id})")

        except Exception as e:
            self.logger.error(f"Error updating presence: {e}")
            self.connection_manager.report_error(e, "Presence update")

    def _upload_metrics(self, metrics: Dict[str, Any]):
        """Upload system metrics to Firestore."""
        if not self.connected or not self.db:
            return

        metrics_ref = self.db.collection('sites').document(self.site_id)\
            .collection('machines').document(self.machine_id)

        try:
            processes_data = metrics.get('processes', {})
            self.logger.debug(f"Uploading metrics with {len(processes_data)} processes: {list(processes_data.keys())}")

            # Use update() with dot notation so metrics.processes is REPLACED
            # entirely (not deep-merged). This ensures deleted processes don't
            # persist as ghost entries in Firestore.
            metrics_ref.update({
                'online': True,
                'lastHeartbeat': SERVER_TIMESTAMP,
                'agent_version': shared_utils.APP_VERSION,
                'machineId': self.machine_id,
                'siteId': self.site_id,
                'metrics.cpu': metrics.get('cpu', {}),
                'metrics.memory': metrics.get('memory', {}),
                'metrics.disk': metrics.get('disk', {}),
                'metrics.gpu': metrics.get('gpu', {}),
                'metrics.network': metrics.get('network', {}),
                'metrics.timestamp': SERVER_TIMESTAMP,
                'metrics.processes': processes_data
            })

        except Exception as e:
            self.logger.error(f"Error uploading metrics: {e}")
            self.connection_manager.report_error(e, "Metrics upload")

    # Command types that execute fast (< 30s) and can run concurrently
    _FAST_COMMAND_TYPES = frozenset({'mcp_tool_call', 'capture_screenshot'})

    def _process_command(self, cmd_id: str, cmd_data: Dict[str, Any]):
        """Dispatch a command to the appropriate execution lane.

        All commands run in threads so the polling callback is never blocked.
        Fast commands (tool calls, screenshots) each get their own thread.
        Slow commands (installs, uninstalls, updates) are serialised via a
        single worker thread to prevent concurrent installs.
        """
        cmd_type = cmd_data.get('type')

        if cmd_type in self._FAST_COMMAND_TYPES:
            t = threading.Thread(
                target=self._execute_command,
                args=(cmd_id, cmd_data),
                name=f"fast-cmd-{cmd_id[:20]}",
                daemon=True,
            )
            t.start()
        else:
            # Slow commands go onto a serialised queue
            self._slow_command_queue.put((cmd_id, cmd_data))

    def _execute_command(self, cmd_id: str, cmd_data: Dict[str, Any]):
        """Execute a command and write the result to Firestore."""
        try:
            cmd_type = cmd_data.get('type')
            self.logger.info(f"Processing command: {cmd_id} - Type: {cmd_type}")

            deployment_id = cmd_data.get('deployment_id')

            if self.command_callback:
                result = self.command_callback(cmd_id, cmd_data)

                is_error = isinstance(result, str) and result.startswith("Error:")

                if cmd_type == 'cancel_installation':
                    self._mark_command_cancelled(cmd_id, result, deployment_id, cmd_type)
                elif is_error:
                    self._mark_command_failed(cmd_id, result, deployment_id, cmd_type)
                else:
                    self._mark_command_completed(cmd_id, result, deployment_id, cmd_type)

                # Log deployment lifecycle events to site logs for audit trail
                deployment_cmd_types = ('install_software', 'uninstall_software', 'update_owlette')
                if cmd_type in deployment_cmd_types and deployment_id:
                    software_name = cmd_data.get('installer_name') or cmd_data.get('software_name') or cmd_type
                    if cmd_type == 'cancel_installation':
                        self.log_event('deployment_cancelled', 'warning', software_name,
                                       f"Deployment {deployment_id} cancelled: {result}")
                    elif is_error:
                        self.log_event('deployment_failed', 'error', software_name,
                                       f"Deployment {deployment_id} failed: {result}")
                    else:
                        self.log_event('deployment_completed', 'info', software_name,
                                       f"Deployment {deployment_id}: {result}")

                # Immediate metrics push so web dashboard sees state change instantly
                try:
                    metrics = shared_utils.get_system_metrics()
                    self._upload_metrics(metrics)
                    self.logger.debug(f"Immediate metrics push after command {cmd_id}")
                except Exception as me:
                    self.logger.warning(f"Post-command metrics push failed: {me}")
            else:
                self.logger.warning(f"No command callback registered, ignoring command {cmd_id}")

        except Exception as e:
            self.logger.error(f"Error processing command {cmd_id}: {e}")
            self._mark_command_failed(cmd_id, str(e), cmd_data.get('deployment_id'), cmd_data.get('type'))
            # Log deployment failure from unhandled exception
            cmd_type = cmd_data.get('type')
            dep_id = cmd_data.get('deployment_id')
            if cmd_type in ('install_software', 'uninstall_software', 'update_owlette') and dep_id:
                software_name = cmd_data.get('installer_name') or cmd_data.get('software_name') or cmd_type
                self.log_event('deployment_failed', 'error', software_name,
                               f"Deployment {dep_id} failed: {e}")

    def _slow_command_worker_loop(self):
        """Drain the slow-command queue one at a time (serialised installs)."""
        while True:
            try:
                cmd_id, cmd_data = self._slow_command_queue.get()
                self._execute_command(cmd_id, cmd_data)
            except Exception as e:
                self.logger.error(f"Slow command worker error: {e}")
            finally:
                self._slow_command_queue.task_done()

    def update_command_progress(self, cmd_id: str, status: str, deployment_id: Optional[str] = None, progress: Optional[int] = None):
        """
        Update command progress in Firestore (for intermediate states like downloading/installing).

        Args:
            cmd_id: Command ID
            status: Current status (e.g., 'downloading', 'installing')
            deployment_id: Optional deployment ID to track
            progress: Optional progress percentage (0-100)
        """
        if not self.connected or not self.db:
            return

        try:
            completed_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('completed')

            progress_data = {
                'status': status,
                'updatedAt': SERVER_TIMESTAMP
            }

            if deployment_id:
                progress_data['deployment_id'] = deployment_id

            if progress is not None:
                progress_data['progress'] = progress

            completed_ref.set({
                cmd_id: progress_data
            }, merge=True)

            self.logger.debug(f"Command {cmd_id} progress: {status}" + (f" ({progress}%)" if progress is not None else ""))

        except Exception as e:
            self.logger.error(f"Failed to update command {cmd_id} progress: {e}")

    def _mark_command_completed(self, cmd_id: str, result: Any, deployment_id: Optional[str] = None, cmd_type: Optional[str] = None):
        """Mark a command as completed in Firestore."""
        if not self.connected or not self.db:
            return

        try:
            pending_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('pending')

            pending_ref.update({
                cmd_id: DELETE_FIELD
            })

            completed_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('completed')

            completed_data = {
                'result': result,
                'status': 'completed',
                'completedAt': SERVER_TIMESTAMP
            }

            if deployment_id:
                completed_data['deployment_id'] = deployment_id

            if cmd_type:
                completed_data['type'] = cmd_type

            completed_ref.set({
                cmd_id: completed_data
            }, merge=True)

            self.logger.info(f"Command {cmd_id} marked as completed")

        except Exception as e:
            self.logger.error(f"Failed to mark command {cmd_id} as completed: {e}")

    def _mark_command_failed(self, cmd_id: str, error: str, deployment_id: Optional[str] = None, cmd_type: Optional[str] = None):
        """Mark a command as failed in Firestore."""
        if not self.connected or not self.db:
            return

        try:
            pending_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('pending')

            pending_ref.update({
                cmd_id: DELETE_FIELD
            })

            completed_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('completed')

            failed_data = {
                'error': error,
                'status': 'failed',
                'completedAt': SERVER_TIMESTAMP
            }

            if deployment_id:
                failed_data['deployment_id'] = deployment_id

            if cmd_type:
                failed_data['type'] = cmd_type

            completed_ref.set({
                cmd_id: failed_data
            }, merge=True)

            self.logger.error(f"Command {cmd_id} marked as failed: {error}")

        except Exception as e:
            self.logger.error(f"Failed to mark command {cmd_id} as failed: {e}")

    def _mark_command_cancelled(self, cmd_id: str, result: str, deployment_id: Optional[str] = None, cmd_type: Optional[str] = None):
        """Mark a command as cancelled in Firestore."""
        if not self.connected or not self.db:
            return

        try:
            pending_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('pending')

            pending_ref.update({
                cmd_id: DELETE_FIELD
            })

            completed_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('completed')

            cancelled_data = {
                'result': result,
                'status': 'cancelled',
                'completedAt': SERVER_TIMESTAMP
            }

            if deployment_id:
                cancelled_data['deployment_id'] = deployment_id

            if cmd_type:
                cancelled_data['type'] = cmd_type

            completed_ref.set({
                cmd_id: cancelled_data
            }, merge=True)

            self.logger.info(f"Command {cmd_id} marked as cancelled")

        except Exception as e:
            self.logger.error(f"Failed to mark command {cmd_id} as cancelled: {e}")

    # =========================================================================
    # Configuration
    # =========================================================================

    def get_config(self) -> Optional[Dict]:
        """
        Get machine configuration from Firestore (or cache if offline).

        Returns:
            Configuration dict or None if not available
        """
        if self.connected and self.db:
            try:
                config_ref = self.db.collection('config').document(self.site_id)\
                    .collection('machines').document(self.machine_id)

                config = config_ref.get()
                if config:
                    self._save_cached_config(config)
                    self.cached_config = config
                    return config
            except Exception as e:
                self.logger.error(f"Failed to get config from Firestore: {e}")
                self.connection_manager.report_error(e, "Get config")

        if self.cached_config:
            self.logger.info("Using cached config (offline mode)")
            return self.cached_config

        return None

    def upload_config(self, config: Dict):
        """
        Upload local config to Firestore.
        Used for initial migration from local config.json.

        Args:
            config: Configuration dict to upload
        """
        if not self.connected or not self.db:
            self.logger.warning("Cannot upload config - not connected to Firestore")
            return

        try:
            config_ref = self.db.collection('config').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            config_ref.set(config, merge=True)

            config_hash = hashlib.md5(json.dumps(config, sort_keys=True).encode()).hexdigest()
            self._last_uploaded_config_hash = config_hash

            self.logger.info(f"Config uploaded to Firestore successfully (hash: {config_hash[:8]}...)")

            self._save_cached_config(config)
            self.cached_config = config

        except Exception as e:
            self.logger.error(f"Failed to upload config to Firestore: {e}")
            self.connection_manager.report_error(e, "Upload config")

    def sync_config_on_startup(self) -> str:
        """
        Pull config from Firestore on startup (Firestore = source of truth).
        If Firestore has no config for this machine, seed it with local config.

        Returns:
            'pulled'  - config was pulled from Firestore and applied locally
            'seeded'  - local config was uploaded as seed (new machine)
            'offline' - Firestore unreachable, using local config as-is
        """
        if not self.connected or not self.db:
            self.logger.warning("Cannot sync config on startup - not connected to Firestore")
            return 'offline'

        try:
            # One-time fetch from Firestore (source of truth)
            firestore_config = self.get_config()

            if firestore_config and 'processes' in firestore_config:
                # Firestore has config — use it
                config_hash = hashlib.md5(
                    json.dumps(firestore_config, sort_keys=True).encode()
                ).hexdigest()
                self._last_uploaded_config_hash = config_hash
                self.logger.info(f"Config pulled from Firestore (hash: {config_hash[:8]}...)")

                # Apply to local config via the same callback used by the listener
                if self.config_update_callback:
                    self.config_update_callback(firestore_config)

                return 'pulled'
            else:
                # Firestore has no config for this machine — seed it with local config
                local_config = shared_utils.read_config()
                if local_config:
                    config_for_firestore = {
                        k: v for k, v in local_config.items() if k != 'firebase'
                    }
                    self.upload_config(config_for_firestore)
                    self.logger.info("New machine - seeded Firestore with local config")
                    return 'seeded'
                else:
                    self.logger.warning("No local config to seed Firestore with")
                    return 'offline'

        except Exception as e:
            self.logger.error(f"Failed to sync config on startup: {e}")
            return 'offline'

    def _load_cached_config(self):
        """Load cached config from disk."""
        try:
            if os.path.exists(self.config_cache_path):
                with open(self.config_cache_path, 'r') as f:
                    self.cached_config = json.load(f)
                self.logger.debug(f"Loaded cached config from {self.config_cache_path}")
        except Exception as e:
            self.logger.error(f"Failed to load cached config: {e}")

    def _save_cached_config(self, config: Dict):
        """Save config to disk cache."""
        try:
            os.makedirs(os.path.dirname(self.config_cache_path), exist_ok=True)
            with open(self.config_cache_path, 'w') as f:
                json.dump(config, f, indent=2)
            self.logger.debug("Config cached to disk")
        except Exception as e:
            self.logger.error(f"Failed to save cached config: {e}")

    # =========================================================================
    # Callback Registration
    # =========================================================================

    def register_command_callback(self, callback: Callable):
        """
        Register a callback function to handle commands.

        Args:
            callback: Function that takes (cmd_id, cmd_data) and returns result
        """
        self.command_callback = callback
        self.logger.debug("Command callback registered")

    def register_config_update_callback(self, callback: Callable):
        """
        Register a callback function to handle config updates.

        Args:
            callback: Function that takes (config) and handles the update
        """
        self.config_update_callback = callback
        self.logger.debug("Config update callback registered")

    # =========================================================================
    # Machine Flags (reboot, shutdown, reboot pending)
    # =========================================================================

    def set_machine_flag(self, flag_name, value):
        """Set a flag on the machine's presence document (e.g., rebooting, shuttingDown)."""
        if not self.connected or not self.db:
            return

        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            machine_ref.set({flag_name: value}, merge=True)
            self.logger.debug(f"[FLAG] Set {flag_name}={value} on machine document")
        except Exception as e:
            self.logger.error(f"Failed to set machine flag {flag_name}: {e}")

    def set_reboot_pending(self, process_name, reason, timestamp):
        """Write a reboot_pending object to the machine document when relaunch limit is exceeded."""
        if not self.connected or not self.db:
            return

        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            machine_ref.set({
                'rebootPending': {
                    'active': True,
                    'processName': process_name,
                    'reason': reason,
                    'timestamp': timestamp
                }
            }, merge=True)
            self.logger.info(f"[FLAG] Reboot pending set for process: {process_name}")
        except Exception as e:
            self.logger.error(f"Failed to set reboot pending: {e}")

    def clear_reboot_pending(self):
        """Clear the reboot_pending flag on the machine document."""
        if not self.connected or not self.db:
            return

        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            machine_ref.set({
                'rebootPending': {
                    'active': False,
                    'processName': None,
                    'reason': None,
                    'timestamp': None
                }
            }, merge=True)
            self.logger.debug("[FLAG] Reboot pending cleared")
        except Exception as e:
            self.logger.error(f"Failed to clear reboot pending: {e}")

    def get_reboot_schedule(self):
        """Read the rebootSchedule field from the machine document.

        Returns:
            dict with 'enabled' and 'schedules' keys, or None if not set.
        """
        if not self.connected or not self.db:
            return None

        try:
            machine_path = f"sites/{self.site_id}/machines/{self.machine_id}"
            machine_doc = self.db.get_document(machine_path)
            if machine_doc:
                return machine_doc.get('rebootSchedule')
            return None
        except Exception as e:
            self.logger.debug(f"Could not read reboot schedule: {e}")
            return None

    # =========================================================================
    # Event Logging
    # =========================================================================

    def log_event(self, action: str, level: str, process_name: str = None, details: str = None, user_id: str = None, **kwargs):
        """
        Log a process event to Firestore for dashboard monitoring.
        Non-blocking - failures are silently ignored to prevent logging from crashing the app.

        Args:
            action: Event action (process_start, process_killed, process_crash, command_executed, etc.)
            level: Log level (info, warning, error)
            process_name: Name of the process involved (optional)
            details: Additional details about the event (optional)
            user_id: User ID if action was triggered by a user (optional)
        """
        if not self.connected or not self.db:
            return

        try:
            logs_ref = self.db.collection('sites').document(self.site_id)\
                .collection('logs')

            event_data = {
                'timestamp': SERVER_TIMESTAMP,
                'action': action,
                'level': level,
                'machineId': self.machine_id,
                'machineName': self.machine_id,
            }

            if process_name:
                event_data['processName'] = process_name
            if details:
                event_data['details'] = details
            if user_id:
                event_data['userId'] = user_id
            if kwargs.get('screenshot_url'):
                event_data['screenshotUrl'] = kwargs['screenshot_url']

            import uuid
            doc_id = str(uuid.uuid4())
            doc_ref = logs_ref.document(doc_id)
            doc_ref.set(event_data)

            self.logger.debug(f"[EVENT LOGGED] {action} - {process_name} ({level})")

        except Exception as e:
            self.logger.debug(f"[EVENT LOG FAILED] {action}: {e}")

    def send_process_alert(self, process_name, error_message, event_type='process_crash'):
        """Send process alert to web API. Non-blocking (fire and forget)."""
        def _send():
            try:
                token = self.auth_manager.get_valid_token()
                api_base = shared_utils.get_api_base_url()
                import requests
                requests.post(
                    f"{api_base}/agent/alert",
                    json={
                        'siteId': self.site_id,
                        'machineId': self.machine_id,
                        'eventType': event_type,
                        'processName': process_name,
                        'errorMessage': error_message or 'Process exited unexpectedly',
                        'agentVersion': shared_utils.APP_VERSION,
                    },
                    headers={'Authorization': f'Bearer {token}'},
                    timeout=10
                )
                self.logger.info(f"[ALERT] Process alert sent: {event_type} - {process_name}")
            except Exception as e:
                self.logger.warning(f"Failed to send process alert: {e}")

        thread = threading.Thread(target=_send, daemon=True)
        thread.start()

    def ship_logs(self, log_entries: list):
        """
        Ship log entries to Firestore for centralized monitoring.
        Non-blocking - failures are silently ignored to prevent logging from crashing the app.

        Args:
            log_entries: List of log entry dicts with keys: timestamp, level, message, logger, filename, line
        """
        if not self.connected or not self.db:
            return

        try:
            batch = self.db.batch()

            logs_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('logs')

            for log_entry in log_entries:
                log_entry['server_timestamp'] = SERVER_TIMESTAMP
                log_entry['machine_id'] = self.machine_id
                log_entry['site_id'] = self.site_id

                doc_ref = logs_ref.document()
                batch.set(doc_ref, log_entry)

            batch.commit()
            self.logger.debug(f"Shipped {len(log_entries)} log entries to Firebase")

        except Exception as e:
            pass  # Silently fail

    # =========================================================================
    # Software Inventory
    # =========================================================================

    def sync_software_inventory(self):
        """
        Manually trigger software inventory sync (public API).

        Call this after software deployments to refresh the inventory.
        Non-blocking - failures are logged but don't raise exceptions.
        """
        try:
            self._sync_software_inventory(force=True)
            self.logger.debug("Software inventory synced on-demand")
        except Exception as e:
            self.logger.error(f"On-demand software inventory sync failed: {e}")

    def _calculate_software_hash(self, software_list):
        """
        Calculate a hash of the software list to detect changes.

        Args:
            software_list: List of software dictionaries

        Returns:
            MD5 hash string of the software list
        """
        sorted_software = sorted(software_list, key=lambda s: (s.get('name', ''), s.get('version', '')))

        software_str = '|'.join([
            f"{s.get('name', '')}:{s.get('version', '')}"
            for s in sorted_software
        ])

        return hashlib.md5(software_str.encode('utf-8')).hexdigest()

    def _sync_software_inventory(self, force=False):
        """
        Sync installed software to Firestore.

        Queries Windows registry for installed software and uploads to:
        sites/{site_id}/machines/{machine_id}/installed_software

        Args:
            force: If True, sync even if software hasn't changed (for on-demand refresh)
        """
        if not self.connected or not self.db:
            return

        try:
            installed_software = registry_utils.get_installed_software()

            if not installed_software:
                self.logger.debug("No installed software detected")
                return

            current_hash = self._calculate_software_hash(installed_software)

            if not force and current_hash == self._last_software_inventory_hash:
                self.logger.debug("Software inventory unchanged, skipping sync")
                return

            software_collection_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('installed_software')

            try:
                existing_docs = software_collection_ref.stream()
                for doc in existing_docs:
                    doc.reference.delete()
            except Exception as e:
                self.logger.warning(f"Failed to clear existing software inventory: {e}")

            batch_write_failed = False

            try:
                batch = self.db.batch()
                batch_count = 0

                for software in installed_software:
                    doc_id = f"{software['name']}_{software['version']}".replace('/', '_').replace('\\', '_')
                    doc_id = doc_id[:1500]

                    doc_ref = software_collection_ref.document(doc_id)

                    software_data = {
                        **software,
                        'detected_at': SERVER_TIMESTAMP
                    }

                    batch.set(doc_ref, software_data)
                    batch_count += 1

                    if batch_count >= 500:
                        batch.commit()
                        batch = self.db.batch()
                        batch_count = 0

                if batch_count > 0:
                    batch.commit()

                self.logger.info(f"Synced {len(installed_software)} software packages to Firestore (batch write)")
                self._last_software_inventory_hash = current_hash

            except Exception as batch_error:
                self.logger.info(f"Batch write not available (using individual writes instead)")
                self.logger.debug(f"Batch write error: {batch_error}")
                batch_write_failed = True

            if batch_write_failed:
                success_count = 0
                for software in installed_software:
                    try:
                        doc_id = f"{software['name']}_{software['version']}".replace('/', '_').replace('\\', '_')
                        doc_id = doc_id[:1500]

                        doc_ref = software_collection_ref.document(doc_id)
                        software_data = {
                            **software,
                            'detected_at': SERVER_TIMESTAMP
                        }
                        doc_ref.set(software_data)
                        success_count += 1
                    except Exception as write_error:
                        self.logger.warning(f"Failed to write {software.get('name', 'unknown')}: {write_error}")

                self.logger.info(f"Synced {success_count}/{len(installed_software)} software packages (individual writes)")
                if success_count > 0:
                    self._last_software_inventory_hash = current_hash

        except Exception as e:
            self.logger.error(f"Failed to sync software inventory: {e}")
            self.logger.exception("Software inventory sync error details:")
            self.connection_manager.report_error(e, "Software inventory sync")


# Example usage / testing
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    # Initialize client (requires auth_manager)
    from auth_manager import AuthManager
    auth_manager = AuthManager(api_base="https://owlette.app/api")

    client = FirebaseClient(
        auth_manager=auth_manager,
        project_id="owlette-dev-3838a",
        site_id="test_site_001"
    )

    def handle_command(cmd_id, cmd_data):
        cmd_type = cmd_data.get('type')
        print(f"Received command: {cmd_type}")

        if cmd_type == 'restart_process':
            process_name = cmd_data.get('process_name')
            print(f"Restarting process: {process_name}")
            return f"Process {process_name} restarted"

        elif cmd_type == 'kill_process':
            process_name = cmd_data.get('process_name')
            print(f"Killing process: {process_name}")
            return f"Process {process_name} killed"

        return "Command executed"

    client.register_command_callback(handle_command)
    client.start()

    test_config = {
        "version": "2.0.3",
        "processes": [
            {
                "name": "TouchDesigner",
                "exe_path": "C:\\TouchDesigner\\bin\\TouchDesigner.exe"
            }
        ]
    }
    client.upload_config(test_config)

    try:
        print("Firebase client running... Press Ctrl+C to stop")
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping...")
        client.stop()
