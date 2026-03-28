"""
Standalone feedback/bug report dialog for Owlette.
Spawned by the GUI's overflow menu — collects a description, attaches
system info + recent logs, and writes to the top-level `bug_reports`
Firestore collection.
"""

import sys
import os
import socket
import platform
import logging
import threading
import customtkinter as ctk

# Ensure agent src is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shared_utils
from custom_messagebox import OwletteMessagebox as CTkMessagebox

shared_utils.initialize_logging('report_issue')
logger = logging.getLogger(__name__)


def build_report_data(category: str, description: str) -> dict:
    """Gather system info and build the Firestore document payload."""
    config = shared_utils.read_config()
    firebase_cfg = config.get('firebase', {})
    site_id = firebase_cfg.get('site_id', '')
    machine_id = firebase_cfg.get('machine_id', '')

    # System info (best-effort)
    system_info = {}
    try:
        system_info = shared_utils.get_system_info()
    except Exception as e:
        logger.warning(f"Failed to gather system info: {e}")

    log_tail = shared_utils.get_log_tail('service', 100)

    return {
        'source': 'agent',
        'category': category,
        'title': 'agent feedback',
        'description': description,
        'status': 'new',
        'machineId': machine_id,
        'hostname': socket.gethostname(),
        'siteId': site_id,
        'os': platform.platform(),
        'agentVersion': shared_utils.APP_VERSION,
        'systemInfo': system_info,
        'logTail': log_tail,
    }


def submit_report(data: dict):
    """Submit the report via the web API (POST /api/bug-report)."""
    import requests
    from auth_manager import AuthManager

    config = shared_utils.read_config()
    firebase_cfg = config.get('firebase', {})
    api_base = firebase_cfg.get('api_base') or shared_utils.get_api_base_url()

    auth = AuthManager(api_base=api_base)
    if not auth.is_authenticated():
        raise RuntimeError("owlette is not connected to a site — please configure firebase first.")

    token = auth.get_valid_token()
    if not token:
        raise RuntimeError("failed to obtain a valid auth token.")

    # Derive the web app base URL from the API base (e.g., https://owlette.app/api -> https://owlette.app)
    web_base = api_base.rstrip('/').removesuffix('/api')

    payload = {
        'title': data.get('title', 'agent feedback'),
        'category': data.get('category', 'bug'),
        'description': data.get('description', ''),
        'browserUA': f"Owlette Agent v{shared_utils.APP_VERSION} / {data.get('os', '')}",
        'pageUrl': f"agent://{data.get('hostname', 'unknown')}",
    }

    # Append system info and logs to the description
    system_info = data.get('systemInfo', {})
    log_tail = data.get('logTail', '')
    extra_context = []
    if system_info:
        extra_context.append(f"\n\n--- system info ---\n{_format_system_info(system_info)}")
    if log_tail:
        extra_context.append(f"\n\n--- recent logs (last ~100 lines) ---\n{log_tail}")
    if extra_context:
        payload['description'] += ''.join(extra_context)

    resp = requests.post(
        f"{web_base}/api/bug-report",
        json=payload,
        headers={'Authorization': f'Bearer {token}'},
        timeout=15,
    )

    if resp.status_code != 200:
        error_msg = resp.json().get('error', resp.text) if resp.headers.get('content-type', '').startswith('application/json') else resp.text
        raise RuntimeError(f"API returned {resp.status_code}: {error_msg}")

    logger.info(f"Bug report submitted via API: {resp.json().get('id', 'unknown')}")


def _format_system_info(info: dict) -> str:
    """Format system info dict into readable lines."""
    lines = []
    for key, value in info.items():
        label = key.replace('_', ' ')
        lines.append(f"  {label}: {value}")
    return '\n'.join(lines)


class ReportIssueApp:
    CATEGORY_MAP = {
        'bug': 'bug',
        'feature request': 'feature_request',
        'compliment': 'compliment',
        'other': 'other',
    }

    def __init__(self):
        ctk.set_appearance_mode("dark")

        self.root = ctk.CTk()
        self.root.title(shared_utils.WINDOW_TITLES.get("report_issue", "feedback"))
        self.root.geometry("450x440")
        self.root.resizable(False, False)
        self.root.configure(fg_color=shared_utils.WINDOW_COLOR)

        # Center on screen
        self.root.update_idletasks()
        x = (self.root.winfo_screenwidth() // 2) - 225
        y = (self.root.winfo_screenheight() // 2) - 220
        self.root.geometry(f"+{x}+{y}")

        # Icon
        try:
            icon_path = shared_utils.get_path('../icons/normal.ico')
            if os.path.exists(icon_path):
                self.root.iconbitmap(icon_path)
        except Exception:
            pass

        self._build_ui()

    def _build_ui(self):
        # Main container with padding
        container = ctk.CTkFrame(self.root, fg_color='transparent')
        container.pack(fill='both', expand=True, padx=20, pady=15)

        # Header
        ctk.CTkLabel(
            container, text="send feedback",
            font=("", 16, "bold"), text_color=shared_utils.TEXT_COLOR,
            anchor='w'
        ).pack(fill='x', pady=(0, 2))

        ctk.CTkLabel(
            container, text="help us improve owlette by reporting issues or requesting features.",
            font=("", 11), text_color="#9ca3af",
            anchor='w', wraplength=400
        ).pack(fill='x', pady=(0, 12))

        # Category selector
        ctk.CTkLabel(
            container, text="category", font=("", 11),
            text_color="#9ca3af", anchor='w'
        ).pack(fill='x', pady=(0, 4))

        self.category_var = ctk.StringVar(value='bug')
        self.category_menu = ctk.CTkOptionMenu(
            container,
            values=['bug', 'feature request', 'compliment', 'other'],
            variable=self.category_var,
            width=200, height=28,
            fg_color=shared_utils.FRAME_COLOR,
            button_color=shared_utils.BUTTON_COLOR,
            button_hover_color=shared_utils.BUTTON_HOVER_COLOR,
            dropdown_fg_color=shared_utils.FRAME_COLOR,
            dropdown_hover_color=shared_utils.BUTTON_HOVER_COLOR,
            font=("", 11),
            corner_radius=shared_utils.CORNER_RADIUS
        )
        self.category_menu.pack(anchor='w', pady=(0, 10))

        # Description
        ctk.CTkLabel(
            container, text="description", font=("", 11),
            text_color="#9ca3af", anchor='w'
        ).pack(fill='x', pady=(0, 4))

        self.description_box = ctk.CTkTextbox(
            container, height=130,
            fg_color=shared_utils.FRAME_COLOR,
            border_color=shared_utils.BORDER_COLOR,
            border_width=1,
            text_color=shared_utils.TEXT_COLOR,
            font=("", 12),
            corner_radius=shared_utils.CORNER_RADIUS
        )
        self.description_box.pack(fill='x', pady=(0, 6))

        # Info label
        ctk.CTkLabel(
            container,
            text="system info and recent logs will be attached automatically.",
            font=("", 10), text_color="#6b7280", anchor='w'
        ).pack(fill='x', pady=(0, 12))

        # Button row
        btn_frame = ctk.CTkFrame(container, fg_color='transparent')
        btn_frame.pack(fill='x')

        self.cancel_btn = ctk.CTkButton(
            btn_frame, text="cancel", width=80, height=30,
            fg_color=shared_utils.BUTTON_COLOR,
            hover_color=shared_utils.BUTTON_HOVER_COLOR,
            font=("", 12),
            corner_radius=shared_utils.CORNER_RADIUS,
            command=self.root.destroy
        )
        self.cancel_btn.pack(side='right', padx=(8, 0))

        self.submit_btn = ctk.CTkButton(
            btn_frame, text="submit", width=80, height=30,
            fg_color=shared_utils.ACCENT_COLOR,
            hover_color=shared_utils.BUTTON_HOVER_COLOR,
            text_color="#020b16",
            font=("", 12, "bold"),
            corner_radius=shared_utils.CORNER_RADIUS,
            command=self._on_submit
        )
        self.submit_btn.pack(side='right')

    def _on_submit(self):
        description = self.description_box.get("1.0", "end").strip()
        if not description:
            CTkMessagebox(
                master=self.root, title="missing description",
                message="please enter a description of the issue.",
                icon="warning", width=400
            )
            return

        # Disable controls
        self.submit_btn.configure(state="disabled", text="submitting...")
        self.cancel_btn.configure(state="disabled")
        self.category_menu.configure(state="disabled")
        self.description_box.configure(state="disabled")

        category_label = self.category_var.get()
        category = self.CATEGORY_MAP.get(category_label, 'other')

        def do_submit():
            try:
                data = build_report_data(category, description)
                submit_report(data)
                self.root.after(0, self._on_success)
            except Exception as e:
                import traceback
                error_msg = str(e) or repr(e) or 'unknown error'
                logger.error(f"Failed to submit report: {error_msg}\n{traceback.format_exc()}")
                self.root.after(0, lambda msg=error_msg: self._on_error(msg))

        threading.Thread(target=do_submit, daemon=True).start()

    def _on_success(self):
        CTkMessagebox(
            master=self.root, title="report submitted",
            message="thank you for your feedback!",
            icon="check", width=400
        )
        self.root.destroy()

    def _on_error(self, error_msg: str):
        self.submit_btn.configure(state="normal", text="submit")
        self.cancel_btn.configure(state="normal")
        self.category_menu.configure(state="normal")
        self.description_box.configure(state="normal")

        CTkMessagebox(
            master=self.root, title="submission failed",
            message=f"failed to submit report:\n{error_msg}",
            icon="cancel", width=500
        )

    def run(self):
        self.root.mainloop()


if __name__ == '__main__':
    try:
        app = ReportIssueApp()
        app.run()
    except Exception as e:
        logger.error(f"Report issue dialog failed: {e}")
