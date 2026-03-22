"""
Owlette Service Runner - NSSM Compatible
Runs the service main loop without Windows Service framework
"""
import sys
import os
import datetime
import logging
import threading
import time
import signal

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shared_utils

# Global reference to service instance for signal handler
_service_instance = None

def signal_handler(signum, frame):
    """Handle Ctrl+C and other termination signals from NSSM"""
    global _service_instance

    # Log to both logger and stderr for visibility
    msg = f"[SIGNAL HANDLER] Received signal {signum} ({signal.Signals(signum).name if hasattr(signal, 'Signals') else 'UNKNOWN'})"
    logging.critical(msg)
    print(msg, file=sys.stderr, flush=True)

    # Check if service instance exists
    if _service_instance is None:
        logging.critical("[SIGNAL HANDLER] ERROR: _service_instance is None - cannot perform graceful shutdown")
        print("[SIGNAL HANDLER] ERROR: _service_instance is None", file=sys.stderr, flush=True)
        sys.exit(0)

    # CRITICAL: NSSM kills the process ~4 seconds after this signal
    # The main loop can't exit fast enough to hit the finally block
    # So we MUST log agent_stopped HERE before we're killed
    if _service_instance.firebase_client:
        try:
            import shared_utils
            version = shared_utils.get_app_version()
            logging.info("[SIGNAL HANDLER] Logging agent_stopped event to Firestore")
            _service_instance.firebase_client.log_event(
                action='agent_stopped',
                level='info',
                details=f'Owlette agent v{version} shutting down gracefully'
            )
            logging.info("[SIGNAL HANDLER] agent_stopped event logged successfully")
            print("[SIGNAL HANDLER] agent_stopped logged", file=sys.stderr, flush=True)
        except Exception as e:
            logging.error(f"[SIGNAL HANDLER] Failed to log agent_stopped: {e}")
            print(f"[SIGNAL HANDLER] Failed to log agent_stopped: {e}", file=sys.stderr, flush=True)

        # Stop Firebase client now
        try:
            _service_instance.firebase_client.stop()
            logging.info("[SIGNAL HANDLER] Firebase client stopped")
        except Exception as e:
            logging.error(f"[SIGNAL HANDLER] Error stopping Firebase: {e}")
    else:
        logging.warning("[SIGNAL HANDLER] No Firebase client - cannot log agent_stopped")

    # Signal main loop to exit gracefully (if we get time)
    if hasattr(_service_instance, 'is_alive'):
        _service_instance.is_alive = False
        logging.info("[SIGNAL HANDLER] is_alive set to False")

    # Exit immediately - NSSM will kill us anyway
    sys.exit(0)

# Initialize Firebase and Auth imports
FIREBASE_AVAILABLE = False
FIREBASE_IMPORT_ERROR = None
try:
    from firebase_client import FirebaseClient
    from auth_manager import AuthManager
    FIREBASE_AVAILABLE = True
except ImportError as e:
    FIREBASE_IMPORT_ERROR = str(e)

if __name__ == '__main__':
    # Initialize logging
    log_level = shared_utils.get_log_level_from_config()
    shared_utils.initialize_logging("service", level=log_level)

    # Wire global exception hooks (after logging is configured)
    from owlette_service import _handle_unhandled_exception, _handle_thread_exception
    sys.excepthook = _handle_unhandled_exception
    threading.excepthook = _handle_thread_exception

    logging.info("="*70)
    logging.info("OWLETTE SERVICE STARTING (NSSM MODE)")
    logging.info("="*70)

    # Import the OwletteService class just to access its main() method
    from owlette_service import OwletteService

    # Create a minimal mock service object with just what main() needs
    class MockService:
        def __init__(self):
            # Initialize results file if it doesn't exist
            import os
            if not os.path.exists(shared_utils.RESULT_FILE_PATH):
                from owlette_service import Util
                Util.initialize_results_file()
                logging.info("Initialized new app_states.json file")

            # Upgrade config to latest version
            logging.info(f"Config path: {shared_utils.CONFIG_PATH}")
            shared_utils.upgrade_config()

            # --- STARTUP HEALTH PROBE ---
            try:
                from health_probe import HealthProbe
                _api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()
                self._health_state = HealthProbe(
                    config_path=shared_utils.CONFIG_PATH,
                    api_base=_api_base,
                ).run()
                logging.info(f"Startup health probe: status={self._health_state.status}, results={self._health_state.probe_results}")
                if not self._health_state.is_ok():
                    logging.error(f"Health probe failed: {self._health_state.error_code} — {self._health_state.error_message}")
            except Exception as e:
                logging.error(f"Health probe error: {e}")
                self._health_state = None

            self._auth_manager = None
            self._api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()

            # Initialize all attributes from OwletteService.__init__
            self.is_alive = True
            self._restart_exit_code = 0
            self.tray_icon_pid = None
            self.relaunch_attempts = {}
            self.first_start = True
            self.last_started = {}
            self.config = shared_utils.load_config()
            self.processes = []
            self.app_states = {}
            self.results = {}
            self.current_time = datetime.datetime.now()
            self.active_installations = {}
            self.manual_overrides = {}

            # Initialize Firebase client
            self.firebase_client = None
            logging.info(f"Firebase check - Available: {FIREBASE_AVAILABLE}")

            if not FIREBASE_AVAILABLE and FIREBASE_IMPORT_ERROR:
                logging.warning(f"Firebase client not available - Import error: {FIREBASE_IMPORT_ERROR}")
                logging.warning("Running in local-only mode")

            if FIREBASE_AVAILABLE:
                firebase_enabled = shared_utils.read_config(['firebase', 'enabled'])
                logging.info(f"Firebase config - enabled: {firebase_enabled}")

                if firebase_enabled:
                    try:
                        site_id = shared_utils.read_config(['firebase', 'site_id'])
                        project_id = shared_utils.read_config(['firebase', 'project_id'])
                        api_base = shared_utils.read_config(['firebase', 'api_base'])
                        cache_path = shared_utils.get_data_path('cache/firebase_cache.json')

                        logging.info(f"Firebase config - site_id: {site_id}, project_id: {project_id}")
                        logging.info(f"Firebase API base: {api_base}")

                        # Initialize AuthManager
                        auth_manager = AuthManager(api_base=api_base)

                        if not auth_manager.is_authenticated():
                            logging.error("Agent not authenticated - no refresh token found in encrypted storage")
                            logging.error("Please run the installer to complete OAuth authentication")
                            self.firebase_client = None
                        else:
                            logging.info("Agent authenticated - OAuth tokens found")
                            self.firebase_client = FirebaseClient(
                                auth_manager=auth_manager,
                                project_id=project_id,
                                site_id=site_id,
                                config_cache_path=cache_path
                            )
                            logging.info(f"Firebase client initialized for site: {site_id}")
                    except Exception as e:
                        logging.error(f"Failed to initialize Firebase client: {e}")
                        logging.exception("Firebase initialization error details:")
                        self.firebase_client = None

            logging.info("Service initialization complete")

    try:
        # Create mock service with required attributes FIRST
        # (before registering signal handlers so they can access it)
        mock_service = MockService()

        # Borrow the main() method from OwletteService
        # We need to bind it to our mock service instance
        _service_instance = object.__new__(OwletteService)
        _service_instance.__dict__.update(mock_service.__dict__)

        # Write early health status so tray can show alerts before Firebase connects
        try:
            _service_instance._write_service_status_early()
        except Exception as e:
            logging.error(f"Failed to write early service status: {e}")

        # NOW register signal handlers (after _service_instance exists)
        signal.signal(signal.SIGINT, signal_handler)   # Ctrl+C
        signal.signal(signal.SIGTERM, signal_handler)  # Termination request
        signal.signal(signal.SIGBREAK, signal_handler) # Ctrl+Break (Windows)
        logging.info("Signal handlers registered for graceful shutdown")

        # CRITICAL: On Windows, NSSM sends console control events, not POSIX signals
        # We need to register a Windows console control handler
        if sys.platform == 'win32':
            try:
                import win32api
                def windows_handler(ctrl_type):
                    """Handle Windows console control events from NSSM"""
                    ctrl_names = {
                        0: 'CTRL_C_EVENT',
                        1: 'CTRL_BREAK_EVENT',
                        2: 'CTRL_CLOSE_EVENT',
                        5: 'CTRL_LOGOFF_EVENT',
                        6: 'CTRL_SHUTDOWN_EVENT'
                    }
                    ctrl_name = ctrl_names.get(ctrl_type, f'UNKNOWN({ctrl_type})')
                    logging.critical(f"[WINDOWS HANDLER] Received {ctrl_name}")
                    print(f"[WINDOWS HANDLER] Received {ctrl_name}", file=sys.stderr, flush=True)

                    # Call the same cleanup logic
                    signal_handler(ctrl_type, None)
                    return True  # Indicate we handled it

                win32api.SetConsoleCtrlHandler(windows_handler, True)
                logging.info("Windows console control handler registered")
            except ImportError:
                logging.warning("win32api not available - Windows control handler not registered")
            except Exception as e:
                logging.error(f"Failed to register Windows control handler: {e}")

        logging.info("Starting main service loop...")
        _service_instance.main()

        # Cleanup before exiting
        logging.info("Main loop exited - performing cleanup...")
        if _service_instance.firebase_client:
            # Only stop if still running (signal handler may have already stopped it)
            if hasattr(_service_instance.firebase_client, 'running') and _service_instance.firebase_client.running:
                try:
                    _service_instance.firebase_client.stop()
                    logging.info("Firebase client stopped")
                except Exception as e:
                    logging.error(f"Error stopping Firebase client: {e}")
            else:
                logging.info("Firebase client already stopped (by signal handler)")

        # Check if service requested a restart (exit code 42 triggers NSSM auto-restart)
        exit_code = getattr(_service_instance, '_restart_exit_code', 0)
        if exit_code:
            logging.info(f"Service exiting with code {exit_code} for NSSM restart")
        else:
            logging.info("Service stopped cleanly (exit 0 — NSSM will not restart)")
        sys.exit(exit_code)

    except KeyboardInterrupt:
        logging.info("Service stopped by user (Ctrl+C)")
        sys.exit(0)
    except Exception as e:
        logging.error(f"Service crashed: {e}", exc_info=True)
        sys.exit(1)
