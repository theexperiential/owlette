"""
Sentry integration for Owlette Agent.
Optional -- if DSN is not configured or sentry-sdk is not installed,
all functions are safe no-ops.
"""
import logging

_sentry_initialized = False


def initialize_sentry(config, version):
    """
    Initialize Sentry SDK if configured and enabled.

    Args:
        config: The full config.json dict
        version: Agent version string (e.g., "2.5.9")
    """
    global _sentry_initialized

    sentry_config = config.get("sentry", {})
    if not sentry_config.get("enabled", False):
        logging.debug("Sentry: disabled in config")
        return

    dsn = sentry_config.get("dsn", "")
    if not dsn:
        logging.warning("Sentry: enabled but no DSN configured")
        return

    try:
        import sentry_sdk

        environment = config.get("environment", "production")
        site_id = config.get("firebase", {}).get("site_id", "unknown")

        import socket
        hostname = socket.gethostname()

        from sentry_sdk.integrations.logging import LoggingIntegration

        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            release=f"owlette-agent@{version}",
            traces_sample_rate=0,  # Free plan: errors only
            integrations=[
                # Only capture CRITICAL log messages (unhandled exceptions),
                # not routine ERROR/WARNING logs from normal service lifecycle
                LoggingIntegration(level=None, event_level=logging.CRITICAL),
            ],
        )

        project_id = config.get("firebase", {}).get("project_id", "unknown")

        sentry_sdk.set_user({
            "id": f"{site_id}/{hostname}",
            "username": hostname,
        })
        sentry_sdk.set_tag("site_id", site_id)
        sentry_sdk.set_tag("hostname", hostname)
        sentry_sdk.set_tag("project_id", project_id)
        sentry_sdk.set_context("machine", {
            "hostname": hostname,
            "site_id": site_id,
            "project_id": project_id,
            "agent_version": version,
        })

        _sentry_initialized = True
        logging.info(f"Sentry: initialized (env={environment}, site={site_id})")

    except ImportError:
        logging.warning("Sentry: sentry-sdk not installed, skipping")
    except Exception as e:
        logging.warning(f"Sentry: failed to initialize: {e}")


def enrich_context(machine_name=None, site_name=None, owner_email=None):
    """Enrich Sentry context with data available after Firebase connects."""
    if not _sentry_initialized:
        return
    try:
        import sentry_sdk
        if owner_email:
            sentry_sdk.set_tag("owner", owner_email)
        if machine_name:
            sentry_sdk.set_tag("machine_name", machine_name)
        if site_name:
            sentry_sdk.set_tag("site_name", site_name)
        context = {}
        if machine_name:
            context["display_name"] = machine_name
        if site_name:
            context["site_name"] = site_name
        if owner_email:
            context["owner"] = owner_email
        if context:
            sentry_sdk.set_context("machine", context)
    except Exception:
        pass


def capture_exception(exc_info=None):
    """Capture an exception to Sentry if initialized."""
    if not _sentry_initialized:
        return
    try:
        import sentry_sdk
        sentry_sdk.capture_exception(exc_info)
    except Exception:
        pass  # Never let Sentry break the service


def capture_message(message, level="error"):
    """Capture a message to Sentry if initialized."""
    if not _sentry_initialized:
        return
    try:
        import sentry_sdk
        sentry_sdk.capture_message(message, level=level)
    except Exception:
        pass


def flush(timeout=2):
    """Flush pending Sentry events. Call before process exit."""
    if not _sentry_initialized:
        return
    try:
        import sentry_sdk
        sentry_sdk.flush(timeout=timeout)
    except Exception:
        pass
