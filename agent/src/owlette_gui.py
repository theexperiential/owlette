import shared_utils
import tkinter as tk
from tkinter import filedialog
import customtkinter as ctk
from CTkListbox import *
from custom_messagebox import OwletteMessagebox as CTkMessagebox
from CTkToolTip import CTkToolTip
import os
import signal
import json
import logging
import uuid
import threading
import subprocess
import time
import socket

# Lazy import for win32serviceutil (heavy dependency - only import when needed)
# import win32serviceutil  # Moved to methods that use it

# Firebase integration - lazy loaded in background thread
# from firebase_client import FirebaseClient  # Moved to background thread
FIREBASE_AVAILABLE = True  # Assume available, handle import errors in background thread

def _lazy_tooltip(widget, message, **opts):
    """Attach a tooltip that is only created on first hover, saving ~25ms per tooltip at startup.
    Returns a holder dict so callers can update the message later:
      - holder['tooltip'] is the CTkToolTip once materialized (None before first hover)
      - holder['message'] is the pending message (used if tooltip not yet created)"""
    holder = {"tooltip": None, "message": message}
    def on_enter(event):
        if holder["tooltip"] is None:
            holder["tooltip"] = CTkToolTip(widget, message=holder["message"], **opts)
            # CTkToolTip binds its own <Enter>/<Leave>, so trigger show now
            widget.event_generate("<Enter>")
    widget.bind("<Enter>", on_enter, add="+")
    return holder

class OwletteConfigApp:

    def __init__(self, master):
        self.master = master

        # Initialize basic window properties
        self.master.title(shared_utils.WINDOW_TITLES["owlette_gui"])

        # Set window icon
        try:
            icon_path = shared_utils.get_path('../icons/normal.ico')
            self.master.iconbitmap(icon_path)
        except Exception as e:
            logging.warning(f"Could not load icon: {e}")

        # Set dark mode
        ctk.set_appearance_mode("dark")

        # Initialize state variables
        self.prev_process_list = None
        self.prev_config_hash = None
        self.selected_process = None
        self.selected_index = None
        self.firebase_client = None
        self.config = None
        self.service_running = None
        self.details_collapsed = True  # Default to collapsed (will be loaded from config)
        self.last_save_time = 0  # Debounce for duplicate save events

        # Load config directly
        self.config = shared_utils.load_config()

        # Load saved UI state (default to collapsed)
        self.details_collapsed = self.config.get('gui', {}).get('details_collapsed', True)

        # Collapsed width for the process-list-only view
        self.collapsed_width = 270

        # Build UI directly - no loading screen
        self.setup_ui()

        # Apply saved window state
        self._apply_window_state()

        # Start background initialization for heavy operations
        self._start_background_initialization()

        # Initialize UI with config data
        self.update_process_list()

        # Set default values if empty
        if not self.time_delay_entry.get():
            self.time_delay_entry.insert(0, 0)
        if not self.time_to_init_entry.get():
            self.time_to_init_entry.insert(0, 10)
        if not self.relaunch_attempts_entry.get():
            self.relaunch_attempts_entry.insert(0, 5)

        # Auto-select first process if any exist
        if self.process_list.size() > 0:
            self.process_list.activate(0)

        # Start periodic updates
        self.master.after(1000, self.update_process_list_periodically)
        self.master.after(1000, self.update_firebase_status_periodically)  # Refresh connection status (initial fast check)

    def _start_background_initialization(self):
        """Start heavy operations in background threads"""
        # Thread 1: Check service status
        def check_service_async():
            try:
                service_name = shared_utils.SERVICE_NAME
                is_running = self.check_service_is_running(service_name)
                self.service_running = is_running

                # If not running, start it
                if not is_running:
                    self.start_service()
                    self.service_running = True

                logging.debug(f"Service status: {'Running' if is_running else 'Started'}")
            except Exception as e:
                logging.error(f"Error checking service: {e}")
                self.service_running = False

        # Thread 2: Initialize Firebase client
        def init_firebase_async():
            try:
                # Lazy import Firebase in background thread
                from firebase_client import FirebaseClient
                from auth_manager import AuthManager

                if self.config.get('firebase', {}).get('enabled', False):
                    site_id = self.config.get('firebase', {}).get('site_id', 'default_site')
                    project_id = self.config.get('firebase', {}).get('project_id') or shared_utils.get_project_id()
                    api_base = self.config.get('firebase', {}).get('api_base') or shared_utils.get_api_base_url()
                    cache_path = shared_utils.get_data_path('cache/firebase_cache.json')

                    # Initialize OAuth authentication manager
                    auth_manager = AuthManager(api_base=api_base)

                    # Check if authenticated
                    if auth_manager.is_authenticated():
                        self.firebase_client = FirebaseClient(
                            auth_manager=auth_manager,
                            project_id=project_id,
                            site_id=site_id,
                            config_cache_path=cache_path
                        )
                        logging.info("GUI Firebase client initialized with OAuth")
                    else:
                        logging.warning("GUI not authenticated - no OAuth tokens found")
                        self.firebase_client = None

                    # Update UI on main thread
                    self.master.after(0, self.update_firebase_status)
                else:
                    # Firebase is disabled - still update status to show "disabled"
                    logging.info("Firebase is disabled in config")
                    self.master.after(0, self.update_firebase_status)
            except ImportError as e:
                logging.warning(f"Firebase not available: {e}")
                self.master.after(0, self.update_firebase_status)
            except Exception as e:
                logging.warning(f"Failed to initialize GUI Firebase client: {e}")
                self.master.after(0, self.update_firebase_status)

        # Start both threads
        threading.Thread(target=check_service_async, daemon=True, name="ServiceCheck").start()
        threading.Thread(target=init_firebase_async, daemon=True, name="FirebaseInit").start()

    def _apply_window_state(self):
        """Apply saved window state (collapsed or expanded)"""
        if self.details_collapsed:
            shared_utils.center_window(self.master, self.collapsed_width, 450)
            self.master.minsize(self.collapsed_width, 450)
            self.details_toggle_button.configure(text="\u276F")
            self.footer_frame.grid_remove()
            self._collapse_right_panel()
        else:
            shared_utils.center_window(self.master, 950, 450)
            self.master.minsize(950, 450)
            self.details_toggle_button.configure(text="\u276E")

    def _collapse_right_panel(self):
        """Hide all right-panel widgets so nothing peeks into collapsed view"""
        self.panel_separator.grid_remove()
        self.process_details_frame.grid_remove()
        for w in getattr(self, '_detail_widgets', []):
            try:
                w.grid_remove()
            except Exception:
                pass
        # Give column 1 weight so process list stretches to fill the full window width
        # Also zero out right-side column weights (6, 8) so they don't steal space
        self.master.grid_columnconfigure(1, weight=1)
        self.master.grid_columnconfigure(6, weight=0)
        self.master.grid_columnconfigure(8, weight=0)

    def _expand_right_panel(self):
        """Restore all right-panel widgets with saved grid positions"""
        # Reset all column weights back to normal for expanded layout
        self.master.grid_columnconfigure(1, weight=0)
        self.master.grid_columnconfigure(6, weight=2)
        self.master.grid_columnconfigure(8, weight=1)
        self.panel_separator.grid(row=0, column=3, rowspan=10, sticky='ns', padx=0, pady=(20, 10))
        self.process_details_frame.grid(row=0, column=4, sticky='news', rowspan=10, columnspan=6, padx=(4, 4), pady=(4, 4))
        # Restore detail widgets using saved grid info (not relying on grid memory)
        for w in getattr(self, '_detail_widgets', []):
            info = self._detail_grid_info.get(id(w))
            if info:
                try:
                    w.grid(**info)
                except Exception:
                    pass
        # Then respect current selection state
        if self.process_list.size() > 0 and self.process_list.curselection() is not None:
            self._show_detail_fields(True)
        else:
            self._show_detail_fields(False)

    def _apply_windows11_theme(self):
        """Apply Windows 11 dark titlebar - deferred for faster startup"""
        try:
            # This works on Windows 11 to set dark titlebar
            self.master.wm_attributes("-alpha", 0.99)  # Slight transparency hack to force dark titlebar
            self.master.wm_attributes("-alpha", 1.0)   # Then set back to full opacity
            # Alternative method for Windows 11
            import ctypes
            HWND = ctypes.windll.user32.GetParent(self.master.winfo_id())
            DWMWA_USE_IMMERSIVE_DARK_MODE = 20
            ctypes.windll.dwmapi.DwmSetWindowAttribute(HWND, DWMWA_USE_IMMERSIVE_DARK_MODE, ctypes.byref(ctypes.c_int(1)), ctypes.sizeof(ctypes.c_int(1)))
            logging.debug("Applied Windows 11 dark theme")
        except Exception as e:
            logging.debug(f"Could not apply Windows 11 theme: {e}")
            pass  # Silently fail if not on Windows 11 or if it doesn't work

    def _get_config_for_firestore(self):
        """
        Get config dict for uploading to Firestore, excluding the firebase section.
        The firebase section contains local authentication config and should never be synced to Firestore.
        """
        return {k: v for k, v in self.config.items() if k != 'firebase'}

    def setup_ui(self):
        # Apply Windows 11 dark theme directly
        self._apply_windows11_theme()

        self.background_frame = ctk.CTkFrame(master=self.master, fg_color=shared_utils.WINDOW_COLOR)
        self.background_frame.place(relx=0, rely=0, relwidth=1, relheight=1)

        # PROCESS LIST (LEFT SIDE)
        # Create a frame for the process list
        self.process_list_frame = ctk.CTkFrame(master=self.master, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.WINDOW_COLOR, border_width=1, border_color=shared_utils.BORDER_COLOR, corner_radius=shared_utils.CORNER_RADIUS)
        self.process_list_frame.grid(row=0, column=0, sticky='nsew', rowspan=10, columnspan=3, padx=(4, 4), pady=(4, 4))

        # Header container frame (spans columns 0-2, row 0)
        self.header_frame = ctk.CTkFrame(self.master, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR)
        self.header_frame.grid(row=0, column=0, columnspan=3, sticky='ew', padx=(14, 14), pady=(12, 0))

        # PROCESSES label (left aligned)
        self.process_list_label = ctk.CTkLabel(self.header_frame, text="processes", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.process_list_label.pack(side='left')

        # Toggle button (right aligned)
        self.details_toggle_button = ctk.CTkButton(self.header_frame, text="\u276E", command=self.toggle_details_panel, width=30, height=30, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=15, font=("Segoe UI", 14))
        self.details_toggle_button.pack(side='right', padx=(0, 5))

        # Add process button (in header, next to toggle)
        self.new_button = ctk.CTkButton(self.header_frame, text="\uff0b", command=self.new_process, width=30, height=30, fg_color=shared_utils.BUTTON_IMPORTANT_COLOR, hover_color=shared_utils.BUTTON_IMPORTANT_HOVER, text_color=shared_utils.BUTTON_IMPORTANT_TEXT, bg_color=shared_utils.FRAME_COLOR, corner_radius=15, font=("Segoe UI", 14))
        self.new_button.pack(side='right', padx=(0, 5))
        _lazy_tooltip(self.new_button, message="add process")

        # Create a Listbox to display the list of processes
        self.process_list = CTkListbox(self.master, command=self.on_select)
        self.process_list.grid(row=1, column=0, columnspan=3, rowspan=9, sticky='nsew', padx=(6, 6), pady=(8, 10))
        self.process_list.configure(highlight_color=shared_utils.HIGHLIGHT_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_width=0)
        # Save default scrollbar colors before _update_scrollbar_visibility modifies them
        # Note: cget uses 'scrollbar_color'/'scrollbar_hover_color' but configure uses 'button_color'/'button_hover_color'
        self._scrollbar_defaults = {
            'fg_color': self.process_list._scrollbar.cget('fg_color'),
            'button_color': self.process_list._scrollbar.cget('scrollbar_color'),
            'button_hover_color': self.process_list._scrollbar.cget('scrollbar_hover_color'),
        }
        # Start as invisible placeholder; _update_scrollbar_visibility will set the correct state
        self.process_list._scrollbar.grid_configure(padx=(0, 8))
        self.process_list._scrollbar.configure(
            width=1,
            fg_color=shared_utils.FRAME_COLOR,
            button_color=shared_utils.FRAME_COLOR,
            button_hover_color=shared_utils.FRAME_COLOR,
        )

        # Custom context menu (built with CTk widgets for modern look)
        self._context_menu_window = None
        self._ctx_bind_id = None

        # Global right-click handler — catches clicks on any widget inside the process list
        self.master.bind_all("<Button-3>", self._on_global_right_click)

        # FOOTER BAR (row 10) — proper frame layout instead of overlapping grid cells
        self.footer_frame = ctk.CTkFrame(self.master, fg_color=shared_utils.WINDOW_COLOR, bg_color=shared_utils.WINDOW_COLOR, corner_radius=0, height=40)
        self.footer_frame.grid(row=10, column=0, columnspan=9, sticky='sew', padx=0, pady=0)
        self.footer_frame.pack_propagate(False)  # Keep fixed height

        # Left section: Firebase status + Site/Machine labels + Site button
        self.footer_left = ctk.CTkFrame(self.footer_frame, fg_color='transparent')
        self.footer_left.pack(side='left', padx=(15, 0), pady=4)

        self.firebase_status_label = ctk.CTkLabel(self.footer_left, text="", fg_color='transparent', text_color=shared_utils.TEXT_COLOR, font=("", 11))
        self.firebase_status_label.pack(side='left', pady=0)

        # Site label in footer (shows site_id, truncated for long names)
        hostname = socket.gethostname()
        site_id = self.config.get('firebase', {}).get('site_id', '')
        site_display = site_id if site_id else "Unassigned"
        site_truncated = site_display[:18] + "\u2026" if len(site_display) > 18 else site_display
        hostname_truncated = hostname[:18] + "\u2026" if len(hostname) > 18 else hostname

        self.footer_site_label = ctk.CTkLabel(self.footer_left, text=f"{site_truncated}", fg_color='transparent', text_color=shared_utils.ACCENT_COLOR, font=("", 11))
        self.footer_site_label.pack(side='left', padx=(8, 0), pady=0)
        self._footer_site_holder = _lazy_tooltip(self.footer_site_label, message=f"Site: {site_display}")

        # Separator dot
        ctk.CTkLabel(self.footer_left, text="\u00b7", fg_color='transparent', text_color=shared_utils.BORDER_COLOR, font=("", 11)).pack(side='left', padx=(6, 0), pady=0)

        # Machine label in footer
        self.footer_machine_label = ctk.CTkLabel(self.footer_left, text=f"{hostname_truncated}", fg_color='transparent', text_color=shared_utils.TEXT_COLOR, font=("", 11))
        self.footer_machine_label.pack(side='left', padx=(6, 0), pady=0)
        _lazy_tooltip(self.footer_machine_label, message=f"Machine: {hostname}")

        self.site_button = ctk.CTkButton(
            self.footer_left,
            text="join site",
            command=self.on_site_button_click,
            width=100,
            height=24,
            fg_color=shared_utils.BUTTON_COLOR,
            hover_color=shared_utils.BUTTON_HOVER_COLOR,
            font=("", 11),
            corner_radius=shared_utils.CORNER_RADIUS
        )
        self.site_button.pack(side='left', padx=(10, 0), pady=0)

        # Center section: Footer text
        footer_text = "made with \u2665 in california by TEC"
        self.footer_label = ctk.CTkLabel(self.footer_frame, text=footer_text, fg_color='transparent', text_color=shared_utils.ACCENT_COLOR, font=("", 11))
        self.footer_label.pack(side='left', expand=True)
        self.footer_label.configure(cursor="hand2")
        self.footer_label.bind("<Button-1>", lambda _: self._open_tec_website())

        # Right section: Overflow menu + Version
        self.footer_right = ctk.CTkFrame(self.footer_frame, fg_color='transparent')
        self.footer_right.pack(side='right', padx=(0, 15), pady=4)

        self._overflow_panel = None  # Track the floating panel

        self.overflow_button = ctk.CTkButton(
            self.footer_right,
            text="···",
            command=self._toggle_overflow_menu,
            width=36,
            height=24,
            fg_color=shared_utils.BUTTON_COLOR,
            hover_color=shared_utils.BUTTON_HOVER_COLOR,
            font=("", 14, "bold"),
            corner_radius=shared_utils.CORNER_RADIUS
        )
        self.overflow_button.pack(side='left', padx=(0, 10))

        self.version_label = ctk.CTkLabel(self.footer_right, text=f"v{shared_utils.APP_VERSION} | FSL-1.1-Apache-2.0", fg_color='transparent', text_color=shared_utils.TEXT_COLOR, font=("", 11))
        self.version_label.pack(side='left')

        # VERTICAL SEPARATOR between panels
        self.panel_separator = ctk.CTkFrame(self.master, fg_color=shared_utils.BORDER_COLOR, bg_color=shared_utils.WINDOW_COLOR, width=1, corner_radius=0)
        self.panel_separator.grid(row=0, column=3, rowspan=10, sticky='ns', padx=(0, 0), pady=(20, 10))

        # PROCESS DETAILS (RIGHT SIDE)
        # Create frame for process details
        self.process_details_frame = ctk.CTkFrame(master=self.master, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.WINDOW_COLOR, border_width=1, border_color=shared_utils.BORDER_COLOR, corner_radius=shared_utils.CORNER_RADIUS)
        self.process_details_frame.grid(row=0, column=4, sticky='news', rowspan=10, columnspan=6, padx=(4, 4), pady=(4, 4))

        # Empty state placeholder (shown when no process is selected)
        self.empty_state_label = ctk.CTkLabel(
            self.process_details_frame,
            text="Select a process to view details",
            fg_color='transparent',
            text_color='#475569',
            font=("", 14)
        )
        self.empty_state_label.place(relx=0.5, rely=0.45, anchor='center')

        # Create a label for the process details
        self.process_details_label = ctk.CTkLabel(self.master, text="process details", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.process_details_label.grid(row=0, column=4, columnspan=3, sticky='w', padx=(20, 10), pady=(20, 0))

        # Invisible spacer — keeps grid layout stable (previously held machine info)
        self.machine_info_frame = ctk.CTkFrame(self.master, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, height=0, width=0)

        # Create launch mode dropdown
        self.launch_mode_label = ctk.CTkLabel(self.master, text="launch mode:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.launch_mode_label.grid(row=1, column=4, sticky='e', padx=(15, 5), pady=5)
        self.launch_mode_options = ["Off", "Always On", "Scheduled"]
        self.launch_mode_menu = ctk.CTkOptionMenu(self.master, values=self.launch_mode_options, command=self.on_launch_mode_change)
        self.launch_mode_menu.configure(fg_color=shared_utils.BUTTON_COLOR, bg_color=shared_utils.FRAME_COLOR, button_color=shared_utils.BUTTON_HOVER_COLOR, button_hover_color=shared_utils.ACCENT_COLOR, width=120, dropdown_fg_color=shared_utils.BUTTON_COLOR, corner_radius=shared_utils.CORNER_RADIUS)
        self.launch_mode_menu.grid(row=1, column=5, columnspan=2, sticky='w', padx=10, pady=5)
        self.launch_mode_menu.set('Off')
        # Read-only schedule info label (shown when mode is Scheduled)
        self.schedule_info_label = ctk.CTkLabel(self.master, text="", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color='#64748b', font=("", 11))
        self.schedule_info_label.grid(row=1, column=7, columnspan=2, sticky='w', padx=(5, 20), pady=5)

        # Create Name of process field
        self.name_label = ctk.CTkLabel(self.master, text="name:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.name_label.grid(row=2, column=4, sticky='e', padx=(15, 5), pady=5)
        self.name_entry = ctk.CTkEntry(self.master, placeholder_text="name of your process", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color=shared_utils.BORDER_COLOR, border_width=1, corner_radius=shared_utils.CORNER_RADIUS)
        self.name_entry.grid(row=2, column=5, columnspan=4, sticky='ew', padx=(10, 20), pady=5)

        # Create Exe path field
        self.exe_path_label = ctk.CTkLabel(self.master, text="exe:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.exe_path_label.grid(row=3, column=4, sticky='e', padx=(15, 5), pady=5)
        self.exe_browse_button = ctk.CTkButton(self.master, text="\uE838", command=self.browse_exe, width=36, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=shared_utils.CORNER_RADIUS, font=("Segoe MDL2 Assets", 14))
        self.exe_browse_button.grid(row=3, column=5, sticky='w', padx=(10, 2), pady=5)
        self.exe_path_entry = ctk.CTkEntry(self.master, placeholder_text="the full path to your executable (application)", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color=shared_utils.BORDER_COLOR, border_width=1, corner_radius=shared_utils.CORNER_RADIUS)
        self.exe_path_entry.grid(row=3, column=6, columnspan=3, sticky='ew', padx=(2, 20), pady=5)

        # Create File path / cmd line args
        self.file_path_label = ctk.CTkLabel(self.master, text="path / args:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.file_path_label.grid(row=4, column=4, sticky='e', padx=(15, 5), pady=5)
        self.file_browse_button = ctk.CTkButton(self.master, text="\uE838", command=self.browse_file, width=36, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=shared_utils.CORNER_RADIUS, font=("Segoe MDL2 Assets", 14))
        self.file_browse_button.grid(row=4, column=5, sticky='w', padx=(10, 2), pady=5)
        self.file_path_entry = ctk.CTkEntry(self.master, placeholder_text="the full path to your document or command line arguments", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color=shared_utils.BORDER_COLOR, border_width=1, corner_radius=shared_utils.CORNER_RADIUS)
        self.file_path_entry.grid(row=4, column=6, columnspan=3, sticky='ew', padx=(2, 20), pady=5)

        # Create CWD path field
        self.cwd_label = ctk.CTkLabel(self.master, text="cwd:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.cwd_label.grid(row=5, column=4, sticky='e', padx=(15, 5), pady=5)
        self.cwd_browse_button = ctk.CTkButton(self.master, text="\uED25", command=self.browse_cwd, width=36, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=shared_utils.CORNER_RADIUS, font=("Segoe MDL2 Assets", 14))
        self.cwd_browse_button.grid(row=5, column=5, sticky='w', padx=(10, 2), pady=5)
        self.cwd_entry = ctk.CTkEntry(self.master, placeholder_text="the working directory for your process", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color=shared_utils.BORDER_COLOR, border_width=1, corner_radius=shared_utils.CORNER_RADIUS)
        self.cwd_entry.grid(row=5, column=6, columnspan=3, sticky='ew', padx=(2, 20), pady=5)

        # Create Time delay label and field
        self.time_delay_label = ctk.CTkLabel(self.master, text="delay (sec):", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.time_delay_label.grid(row=6, column=4, sticky='e', padx=(15, 5), pady=5)
        self.time_delay_entry = ctk.CTkEntry(self.master, placeholder_text="0", width=50, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR, border_color=shared_utils.BORDER_COLOR, border_width=1, corner_radius=shared_utils.CORNER_RADIUS)
        self.time_delay_entry.grid(row=6, column=5, columnspan=2, sticky='w', padx=(10, 5), pady=5)

        # Create Priority dropdown
        self.priority_label = ctk.CTkLabel(self.master, text="priority:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.priority_label.grid(row=6, column=7, sticky='e', padx=5, pady=5)
        self.priority_options = ["Low", "Normal", "High", "Realtime"]
        self.priority_menu = ctk.CTkOptionMenu(self.master, values=self.priority_options, command=self.update_selected_process)
        self.priority_menu.configure(fg_color=shared_utils.BUTTON_COLOR, bg_color=shared_utils.FRAME_COLOR, button_color=shared_utils.BUTTON_HOVER_COLOR, button_hover_color=shared_utils.ACCENT_COLOR, width=100, dropdown_fg_color=shared_utils.BUTTON_COLOR, corner_radius=shared_utils.CORNER_RADIUS)
        self.priority_menu.grid(row=6, column=8, sticky='w', padx=(5, 20), pady=5)
        self.priority_menu.set('Normal')

        # Create a label and entry for "Time to Initialize"
        self.time_to_init_label = ctk.CTkLabel(self.master, text="wait (sec):", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.time_to_init_label.grid(row=7, column=4, sticky='e', padx=(15, 5), pady=5)
        self.time_to_init_entry = ctk.CTkEntry(self.master, placeholder_text="10", width=50, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR, border_color=shared_utils.BORDER_COLOR, border_width=1, corner_radius=shared_utils.CORNER_RADIUS)
        self.time_to_init_entry.grid(row=7, column=5, columnspan=2, sticky='w', padx=(10, 5), pady=5)

        # Create Visibility dropdown
        self.visibility_label = ctk.CTkLabel(self.master, text="visibility:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.visibility_label.grid(row=7, column=7, sticky='e', padx=5, pady=5)
        self.visibility_options = ["Normal", "Hidden"]
        self.visibility_menu = ctk.CTkOptionMenu(self.master, values=self.visibility_options, command=self.update_selected_process)
        self.visibility_menu.configure(width=100, fg_color=shared_utils.BUTTON_COLOR, bg_color=shared_utils.FRAME_COLOR, button_color=shared_utils.BUTTON_HOVER_COLOR, button_hover_color=shared_utils.ACCENT_COLOR, dropdown_fg_color=shared_utils.BUTTON_COLOR, corner_radius=shared_utils.CORNER_RADIUS)
        self.visibility_menu.grid(row=7, column=8, sticky='w', padx=(5, 20), pady=5)
        self.visibility_menu.set('Normal')

        # Create a label and entry for "Restart Attempts"
        self.relaunch_attempts_label = ctk.CTkLabel(self.master, text="attempts:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.relaunch_attempts_label.grid(row=8, column=4, sticky='e', padx=(15, 5), pady=5)
        self.relaunch_attempts_entry = ctk.CTkEntry(self.master, placeholder_text="5", width=50, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR, border_color=shared_utils.BORDER_COLOR, border_width=1, corner_radius=shared_utils.CORNER_RADIUS)
        self.relaunch_attempts_entry.grid(row=8, column=5, columnspan=2, sticky='w', padx=(10, 5), pady=5)

        # BINDINGS
        # Bind the Entry widgets to auto-save when Return is pressed or focus is lost
        self.name_entry.bind('<Return>', self.update_selected_process)
        self.name_entry.bind('<FocusOut>', self.update_selected_process)

        self.exe_path_entry.bind('<Return>', self.update_selected_process)
        self.exe_path_entry.bind('<FocusOut>', self.update_selected_process)

        self.file_path_entry.bind('<Return>', self.update_selected_process)
        self.file_path_entry.bind('<FocusOut>', self.update_selected_process)

        self.cwd_entry.bind('<Return>', self.update_selected_process)
        self.cwd_entry.bind('<FocusOut>', self.update_selected_process)

        self.time_delay_entry.bind('<Return>', self.update_selected_process)
        self.time_delay_entry.bind('<FocusOut>', self.update_selected_process)

        self.time_to_init_entry.bind('<Return>', self.update_selected_process)
        self.time_to_init_entry.bind('<FocusOut>', self.update_selected_process)

        self.relaunch_attempts_entry.bind('<Return>', self.update_selected_process)
        self.relaunch_attempts_entry.bind('<FocusOut>', self.update_selected_process)

        # Bind a mouse click event to the root window to defocus entry fields
        self.master.bind("<Button-1>", self.defocus_entry)

        # Tooltips (lazy — only created on first hover to speed up startup)
        tooltip_opts = {"delay": 0.5, "alpha": 0.95, "corner_radius": shared_utils.CORNER_RADIUS}
        _lazy_tooltip(self.launch_mode_label, message="Off: not managed | Always On: 24/7 with crash recovery | Scheduled: runs during configured time windows", **tooltip_opts)
        _lazy_tooltip(self.launch_mode_menu, message="Off: not managed | Always On: 24/7 with crash recovery | Scheduled: runs during configured time windows", **tooltip_opts)
        _lazy_tooltip(self.name_label, message="Display name for this process", **tooltip_opts)
        _lazy_tooltip(self.name_entry, message="Display name for this process", **tooltip_opts)
        _lazy_tooltip(self.exe_path_label, message="Full path to the executable (.exe)", **tooltip_opts)
        _lazy_tooltip(self.exe_path_entry, message="Full path to the executable (.exe)", **tooltip_opts)
        _lazy_tooltip(self.exe_browse_button, message="Browse for an executable file", **tooltip_opts)
        _lazy_tooltip(self.file_path_label, message="A file to open with the executable, or CLI arguments", **tooltip_opts)
        _lazy_tooltip(self.file_path_entry, message="A file to open with the executable (e.g. a .toe project),\nor command line arguments (e.g. --verbose --port 8080)", **tooltip_opts)
        _lazy_tooltip(self.file_browse_button, message="Browse for a file to pass to the executable", **tooltip_opts)
        _lazy_tooltip(self.cwd_label, message="Working directory for the process", **tooltip_opts)
        _lazy_tooltip(self.cwd_entry, message="Working directory for the process", **tooltip_opts)
        _lazy_tooltip(self.cwd_browse_button, message="Browse for a working directory", **tooltip_opts)
        _lazy_tooltip(self.time_delay_label, message="Seconds to wait before launching this process on startup", **tooltip_opts)
        _lazy_tooltip(self.time_delay_entry, message="Seconds to wait before launching this process on startup", **tooltip_opts)
        _lazy_tooltip(self.priority_label, message="CPU priority level for the process", **tooltip_opts)
        _lazy_tooltip(self.priority_menu, message="CPU priority level for the process", **tooltip_opts)
        _lazy_tooltip(self.time_to_init_label, message="Seconds to wait after launch before monitoring starts", **tooltip_opts)
        _lazy_tooltip(self.time_to_init_entry, message="Seconds to wait after launch before monitoring starts", **tooltip_opts)
        visibility_tip = ("Window visibility on launch.\n"
                          "Hidden suppresses the console window, ideal for\n"
                          "background scripts and services. Apps that create\n"
                          "their own GUI windows (e.g. tkinter, Qt, WPF)\n"
                          "will still be visible.")
        _lazy_tooltip(self.visibility_label, message=visibility_tip, **tooltip_opts)
        _lazy_tooltip(self.visibility_menu, message=visibility_tip, **tooltip_opts)
        _lazy_tooltip(self.relaunch_attempts_label, message="Max restart attempts before giving up (0 = unlimited)", **tooltip_opts)
        _lazy_tooltip(self.relaunch_attempts_entry, message="Max restart attempts before giving up (0 = unlimited)", **tooltip_opts)
        _lazy_tooltip(self.new_button, message="Add process", **tooltip_opts)
        _lazy_tooltip(self.details_toggle_button, message="Show/hide process details panel", **tooltip_opts)
        _lazy_tooltip(self.overflow_button, message="Config, logs, docs, feedback", **tooltip_opts)
        _lazy_tooltip(self.site_button, message="Join or leave a cloud site for remote management", **tooltip_opts)

        # Make columns stretchable
        # Left side (process list): columns 0-2 - VERY high weight to dominate space
        self.master.grid_columnconfigure(0, weight=0)
        self.master.grid_columnconfigure(1, weight=0)
        self.master.grid_columnconfigure(2, weight=0)
        # Separator: column 3
        self.master.grid_columnconfigure(3, weight=0, minsize=0)
        # Right side (process details): columns 4-8
        self.master.grid_columnconfigure(4, weight=0)  # Labels column
        self.master.grid_columnconfigure(5, weight=0)  # Browse icon column (narrow)
        self.master.grid_columnconfigure(6, weight=2)  # Main input column
        self.master.grid_columnconfigure(7, weight=0)  # Second label column
        self.master.grid_columnconfigure(8, weight=1)  # Second input column

        # Give row 9 (empty spacer before footer) all the weight so the footer stays at the bottom
        self.master.grid_rowconfigure(9, weight=1)

        # Collect all detail field widgets for empty state management
        self._detail_widgets = [
            self.process_details_label,
            self.launch_mode_label, self.launch_mode_menu, self.schedule_info_label,
            self.name_label, self.name_entry,
            self.exe_path_label, self.exe_browse_button, self.exe_path_entry,
            self.file_path_label, self.file_browse_button, self.file_path_entry,
            self.cwd_label, self.cwd_browse_button, self.cwd_entry,
            self.time_delay_label, self.time_delay_entry,
            self.priority_label, self.priority_menu,
            self.time_to_init_label, self.time_to_init_entry,
            self.visibility_label, self.visibility_menu,
            self.relaunch_attempts_label, self.relaunch_attempts_entry,
        ]

        # Save grid info for all detail widgets (used to restore after grid_remove)
        self._detail_grid_info = {}
        for w in self._detail_widgets:
            info = w.grid_info()
            if info:
                self._detail_grid_info[id(w)] = {k: v for k, v in info.items() if k != 'in'}

        # Start with details hidden (no process selected)
        self._show_detail_fields(False)

    def _show_detail_fields(self, show):
        """Show or hide all detail fields, toggling the empty state placeholder."""
        # Don't show detail widgets when the right panel is collapsed
        if self.details_collapsed:
            return
        if show:
            self.empty_state_label.place_forget()
            for w in self._detail_widgets:
                try:
                    w.grid()
                except Exception:
                    pass  # Some widgets use pack (machine_info_frame children)
        else:
            self.empty_state_label.place(relx=0.5, rely=0.45, anchor='center')
            for w in self._detail_widgets:
                try:
                    w.grid_remove()
                except Exception:
                    pass

    def toggle_details_panel(self):
        """Toggle collapse/expand window (crop to show/hide right panel)"""
        # Get current window position to preserve it
        geometry = self.master.geometry()  # e.g., "950x450+100+200"
        parts = geometry.split('+')
        if len(parts) >= 3:
            # Extract position (x, y coordinates)
            x = parts[1]
            y = parts[2]
        else:
            # Fallback: center the window if position not available
            x = None
            y = None

        if self.details_collapsed:
            # EXPAND
            self.details_toggle_button.configure(text="\u276E")
            self._expand_right_panel()
            self.footer_frame.grid()
            self.master.minsize(950, 450)
            if x and y:
                self.master.geometry(f'950x450+{x}+{y}')
            else:
                shared_utils.center_window(self.master, 950, 450)
            self.details_collapsed = False
        else:
            # COLLAPSE
            self.details_toggle_button.configure(text="\u276F")
            self.footer_frame.grid_remove()
            self._collapse_right_panel()
            self.master.minsize(self.collapsed_width, 450)
            if x and y:
                self.master.geometry(f'{self.collapsed_width}x450+{x}+{y}')
            else:
                shared_utils.center_window(self.master, self.collapsed_width, 450)
            self.details_collapsed = True

        # Save state to config
        if 'gui' not in self.config:
            self.config['gui'] = {}
        self.config['gui']['details_collapsed'] = self.details_collapsed
        shared_utils.save_config(self.config)

        self.master.update()

    # PROCESS HANDLING

    def on_launch_mode_change(self, selected_mode=None):
        if self.selected_process:
            index = shared_utils.get_process_index(self.selected_process)
            mode_map = {"Off": "off", "Always On": "always", "Scheduled": "scheduled"}
            new_mode = mode_map.get(selected_mode, 'off')

            # If enabling (not off), validate required fields
            if new_mode != 'off':
                name = self.config['processes'][index].get('name', '')
                exe_path = self.config['processes'][index].get('exe_path', '').strip()

                if not name or not exe_path:
                    CTkMessagebox(master=self.master, title="Validation Error", message="Name and Exe Path are required to enable launch mode.", icon="cancel")
                    self.launch_mode_menu.set('Off')
                    return

                # Validate that executable path actually exists
                if not os.path.isfile(exe_path):
                    CTkMessagebox(master=self.master, title="Validation Error", message=f"Cannot enable launch mode: Executable path does not exist.\n\n{exe_path}\n\nPlease set a valid executable path first.", icon="cancel")
                    self.launch_mode_menu.set('Off')
                    return

            self.config['processes'][index]['launch_mode'] = new_mode
            # Derive autolaunch for backward compat
            self.config['processes'][index]['autolaunch'] = new_mode != 'off'
            # Update schedule info display
            self._update_schedule_info_label(self.config['processes'][index])
            shared_utils.save_config(self.config)

            # Upload to Firestore immediately for fast sync (in background thread)
            if self.firebase_client:
                def upload_in_background():
                    try:
                        self.firebase_client.upload_config(self._get_config_for_firestore())
                        logging.debug("Config uploaded to Firestore immediately after toggle")

                        # Push metrics so web app sees the change immediately
                        metrics = shared_utils.get_system_metrics(skip_gpu=True)
                        self.firebase_client._upload_metrics(metrics)
                        logging.debug("Metrics pushed to Firestore after toggle")
                    except Exception as e:
                        logging.error(f"Failed to upload to Firestore: {e}")

                # Run in background thread so GUI stays responsive
                upload_thread = threading.Thread(target=upload_in_background, daemon=True)
                upload_thread.start()

            # Status message if process has been launched
            try:
                pid = shared_utils.fetch_pid_by_id(self.config['processes'][index]['id'])
                shared_utils.update_process_status_in_json(pid, 'INACTIVE' if new_mode == 'off' else 'QUEUED', process_id=self.config['processes'][index]['id'])
            except Exception as e:
                logging.info(e)

    def _update_schedule_info_label(self, process):
        """Show read-only schedule summary when mode is Scheduled."""
        mode = process.get('launch_mode', 'off')
        schedules = process.get('schedules')
        if mode == 'scheduled' and schedules:
            parts = []
            for block in schedules:
                days = block.get('days', [])
                ranges = block.get('ranges', [])
                day_str = ', '.join(d.capitalize() for d in days) if days else 'All days'
                range_str = ', '.join(f"{r['start']}-{r['stop']}" for r in ranges)
                parts.append(f"{day_str}: {range_str}")
            self.schedule_info_label.configure(text=' | '.join(parts))
        elif mode == 'scheduled':
            self.schedule_info_label.configure(text='(no schedule set — configure via web)')
        else:
            self.schedule_info_label.configure(text='')

    def new_process(self):
        """Create a new process entry immediately with default values"""
        # Generate unique ID
        unique_id = str(uuid.uuid4())

        # Create new process with default values
        new_process = {
            'id': unique_id,
            'name': 'Untitled Process',
            'exe_path': '',
            'file_path': '',
            'cwd': '',
            'priority': 'Normal',
            'visibility': 'Show',
            'time_delay': '0',
            'time_to_init': '10',
            'relaunch_attempts': '5',
            'launch_mode': 'off',
            'autolaunch': False,
            'schedules': None
        }

        # Add to config and save
        self.config['processes'].append(new_process)
        shared_utils.save_config(self.config)

        # Upload to Firestore immediately for fast sync (in background thread)
        if self.firebase_client:
            def upload_in_background():
                try:
                    self.firebase_client.upload_config(self._get_config_for_firestore())
                    logging.debug("Config uploaded to Firestore immediately after new process")

                    # Push metrics so web app sees the change immediately
                    metrics = shared_utils.get_system_metrics(skip_gpu=True)
                    self.firebase_client._upload_metrics(metrics)
                    logging.debug("Metrics pushed to Firestore after new process")
                except Exception as e:
                    logging.error(f"Failed to upload to Firestore: {e}")

            # Run in background thread so GUI stays responsive
            upload_thread = threading.Thread(target=upload_in_background, daemon=True)
            upload_thread.start()

        # Update the process list to show the new entry
        self.update_process_list()

        # Calculate index for the new process
        new_index = len(self.config['processes']) - 1

        # Delay activation to allow UI to fully update
        self.master.after(150, lambda: self._activate_new_process(new_index))

    def _activate_new_process(self, index):
        """Helper method to activate and focus on a newly created process"""
        try:
            self.process_list.activate(index)
            # Focus on the name field for easy editing
            self.name_entry.focus_set()
            self.name_entry.select_range(0, tk.END)  # Select all text for easy replacement
        except Exception as e:
            logging.error(f"Error activating new process: {e}")

    def update_selected_process(self,event=None):
        import time
        # Debounce: Prevent duplicate saves within 100ms (Return + FocusOut events)
        current_time = time.time()
        if current_time - self.last_save_time < 0.1:
            return  # Skip duplicate event
        self.last_save_time = current_time
        # Determine if this is a "soft save" (triggered by Enter key) or "hard save" (Save Changes button)
        is_soft_save = event is not None

        # Field Validation
        name = self.name_entry.get()
        exe_path = self.exe_path_entry.get()
        file_path = self.file_path_entry.get()
        cwd = self.cwd_entry.get()
        priority = self.priority_menu.get()
        visibility = self.visibility_menu.get()
        time_delay = self.time_delay_entry.get()
        time_to_init = self.time_to_init_entry.get()
        relaunch_attempts = self.relaunch_attempts_entry.get()

        # Validate Time Delay
        try:
            if float(time_delay):  # Try converting the time delay to a float
                if float(time_delay) < 0:
                    raise ValueError("Start Time Delay must be greater than or equal to 0.")

        except ValueError:
            if not is_soft_save:
                CTkMessagebox(master=self.master, title="Validation Error", message="Start Time Delay must be a number (integer or float).", icon="cancel")
                self.time_delay_entry.delete(0, tk.END)
                self.time_delay_entry.insert(0, 0)
                return
            else:
                # For soft saves, just use default value but continue saving
                time_delay = '0'

        # Validate Time To Init
        try:
            if float(time_to_init):  # Try converting the time to init to a float
                if float(time_to_init) < 10 or float(time_to_init) == 0:
                    raise ValueError("Time to initialize must be greater than or equal to 10 seconds.")
        except ValueError:
            if not is_soft_save:
                CTkMessagebox(master=self.master, title="Validation Error", message="Time to Initialize must be at least 10 seconds", icon="cancel")
                self.time_to_init_entry.delete(0, tk.END)
                self.time_to_init_entry.insert(0, 10)
                return
            else:
                # For soft saves, just use default value but continue saving
                time_to_init = '10'

        # Validate CWD
        if cwd and not os.path.isdir(cwd):
            if not is_soft_save:
                CTkMessagebox(master=self.master, title="Validation Error", message="The specified working directory does not exist.", icon="cancel")
                return
            # For soft saves, allow invalid paths (user might be typing)

        # Validate Relaunch Attempts
        try:
            if int(relaunch_attempts):  # Try converting the relaunch attempts to an integer
                if int(relaunch_attempts) < 0:
                    raise ValueError("Relaunch attempts must be >=0")
        except ValueError:
            if not is_soft_save:
                CTkMessagebox(master=self.master, title="Validation Error", message="Relaunch attempts must be an integer. 5 is recommended. After 5 attempts, a system restart will be attempted. Set to 0 for unlimited attempts to relaunch (no system restart).", icon="cancel")
                self.relaunch_attempts_entry.delete(0, tk.END)
                self.relaunch_attempts_entry.insert(0, 5)
                return
            else:
                # For soft saves, just use default value but continue saving
                relaunch_attempts = '5'

        # Check if relaunch attempts is empty and set to default if so
        if not relaunch_attempts:
            relaunch_attempts = 5  # Default value

        # Check if time to init is empty and set to default if so
        if not time_to_init:
            time_to_init = 60  # Default value

        # Write config
        if self.selected_process:
            # Updating existing process
            # For soft saves (Enter key), only save if at least name is filled
            # For hard saves (Save Changes button), require both name and exe_path
            if is_soft_save:
                # Soft save: just save whatever is there, no validation errors
                if not name:
                    # If name is empty, just return without saving or showing error
                    return
            else:
                # Hard save: strict validation
                if not name or not exe_path:
                    CTkMessagebox(master=self.master, title="Validation Error", message="Name and Exe Path are required fields.", icon="cancel")
                    return

            index = shared_utils.get_process_index(self.selected_process)

            # For soft saves (FocusOut/Enter), skip if no form fields actually changed.
            # This prevents uploading stale config to Firestore when focus shifts
            # (e.g. after Firestore updates config.json but before GUI's 1s poll).
            if is_soft_save:
                proc = self.config['processes'][index]
                form_vals = (name, exe_path, file_path, cwd, priority, visibility,
                             str(time_delay), str(time_to_init), str(relaunch_attempts))
                cfg_vals = (proc.get('name', ''), proc.get('exe_path', ''),
                            proc.get('file_path', ''), proc.get('cwd', ''),
                            proc.get('priority', 'Normal'), proc.get('visibility', 'Normal'),
                            str(proc.get('time_delay', '0')), str(proc.get('time_to_init', '10')),
                            str(proc.get('relaunch_attempts', '5')))
                if form_vals == cfg_vals:
                    return  # Nothing changed — don't save or upload

            self.config['processes'][index]['name'] = name
            self.config['processes'][index]['exe_path'] = exe_path
            self.config['processes'][index]['file_path'] = file_path
            self.config['processes'][index]['cwd'] = cwd
            self.config['processes'][index]['priority'] = priority
            self.config['processes'][index]['visibility'] = visibility
            self.config['processes'][index]['time_delay'] = time_delay
            self.config['processes'][index]['time_to_init'] = time_to_init
            self.config['processes'][index]['relaunch_attempts'] = relaunch_attempts

            shared_utils.save_config(self.config)

            # Update the config hash to prevent auto-refresh from reverting the change
            import hashlib
            config_str = json.dumps(self.config['processes'][index], sort_keys=True)
            self.prev_config_hash = hashlib.md5(config_str.encode()).hexdigest()

            # Upload to Firestore immediately for fast sync (in background thread)
            if self.firebase_client:
                def upload_in_background():
                    try:
                        self.firebase_client.upload_config(self._get_config_for_firestore())
                        logging.debug("Config uploaded to Firestore immediately after process update")

                        # Push metrics so web app sees the change immediately
                        metrics = shared_utils.get_system_metrics(skip_gpu=True)
                        self.firebase_client._upload_metrics(metrics)
                        logging.debug("Metrics pushed to Firestore after process update")
                    except Exception as e:
                        logging.error(f"Failed to upload to Firestore: {e}")

                # Run in background thread so GUI stays responsive
                upload_thread = threading.Thread(target=upload_in_background, daemon=True)
                upload_thread.start()

            self.update_process_list()

            # Re-select the process
            self.process_list.activate(index)
        else:
            # Adding new process (no process selected)
            # For soft saves, skip validation entirely
            if is_soft_save:
                return

            # Hard save: strict validation
            if not name or not exe_path:
                CTkMessagebox(master=self.master, title="Validation Error", message="Name and Exe Path are required fields.", icon="cancel")
                return

            if not os.path.exists(exe_path):
                CTkMessagebox(master=self.master, title="Validation Error", message="The specified Exe Path does not exist.", icon="cancel")
                return

            if file_path and not os.path.exists(file_path):
                CTkMessagebox(master=self.master, title="Validation Error", message="The specified File Path does not exist.", icon="cancel")
                return

            # Generate unique ID
            unique_id = str(uuid.uuid4())
            mode_map = {"Off": "off", "Always On": "always", "Scheduled": "scheduled"}
            launch_mode = mode_map.get(self.launch_mode_menu.get(), 'off')

            new_process = {
                'id': unique_id,
                'name': name,
                'exe_path': exe_path,
                'file_path': file_path,
                'cwd': cwd,
                'priority': priority,
                'visibility': visibility,
                'time_delay': time_delay,
                'time_to_init': time_to_init,
                'relaunch_attempts': relaunch_attempts,
                'launch_mode': launch_mode,
                'autolaunch': launch_mode != 'off',
                'schedules': None
            }

            self.config['processes'].append(new_process)
            shared_utils.save_config(self.config)
            self.update_process_list()

            # Select the newly added process
            self.process_list.activate(len(self.config['processes']) - 1)

        self.master.focus_set() # Defocus from the entry widget back to root

    def add_process(self):
        # Generate a unique ID for the new process
        unique_id = str(uuid.uuid4())

        name = self.name_entry.get()
        exe_path = self.exe_path_entry.get()
        file_path = self.file_path_entry.get()
        cwd = self.cwd_entry.get()
        priority = self.priority_menu.get()
        visibility = self.visibility_menu.get()
        time_delay = self.time_delay_entry.get() if self.time_delay_entry.get() else 0 # Default to 0 if empty
        time_to_init = self.time_to_init_entry.get() if self.time_to_init_entry.get() else 60 # Default to 60 if empty
        relaunch_attempts = self.relaunch_attempts_entry.get() if self.relaunch_attempts_entry.get() else 5 # Default to 5 if empty
        mode_map = {"Off": "off", "Always On": "always", "Scheduled": "scheduled"}
        launch_mode = mode_map.get(self.launch_mode_menu.get(), 'off')

        if not name or not exe_path:
            CTkMessagebox(master=self.master, title="Validation Error", message="Name and Exe Path are required fields.", icon="cancel")
            return

        if not os.path.exists(exe_path):
            CTkMessagebox(master=self.master, title="Validation Error", message="The specified Exe Path does not exist.", icon="cancel")
            return

        if file_path and not os.path.exists(file_path):
            CTkMessagebox(master=self.master, title="Validation Error", message="The specified File Path does not exist.", icon="cancel")
            return

        new_process = {
            'id': unique_id,
            'name': name,
            'exe_path': exe_path,
            'file_path': file_path,
            'cwd': cwd,
            'priority': priority,
            'visibility': visibility,
            'time_delay': time_delay,
            'time_to_init': time_to_init,
            'relaunch_attempts': relaunch_attempts,
            'launch_mode': launch_mode,
            'autolaunch': launch_mode != 'off',
            'schedules': None
        }

        self.config['processes'].append(new_process)
        shared_utils.save_config(self.config)
        self.update_process_list()

    # BROWSING FOR FILES

    def browse_exe(self):
        exe_path = filedialog.askopenfilename(initialdir="C:/", title="Select Exe File", filetypes=[("Executable files", "*.exe")])
        if not exe_path:
            return
        self.exe_path_entry.delete(0, tk.END)
        self.exe_path_entry.insert(0, exe_path)
        self.update_selected_process()

    def browse_file(self):
        file_path = filedialog.askopenfilename(initialdir="C:/", title="Select File")
        if not file_path:
            return
        self.file_path_entry.delete(0, tk.END)
        self.file_path_entry.insert(0, file_path)
        self.update_selected_process()

    def browse_cwd(self):
        cwd = filedialog.askdirectory(initialdir="C:/", title="Select Working Directory")
        if not cwd:
            return
        self.cwd_entry.delete(0, tk.END)
        self.cwd_entry.insert(0, cwd)
        self.update_selected_process()

    # PROCESS LIST

    def get_os_pid_by_process_id(self, process_list_id, result_file_path):
        app_states = shared_utils.read_json_from_file(result_file_path)

        # Defensive programming: ensure app_states is never None
        if app_states is None:
            app_states = {}

        # Find the RUNNING PID for this process (not killed/stale entries)
        matching = [(pid, info) for pid, info in app_states.items()
                    if info.get('id') == process_list_id]
        # Prefer RUNNING status, fall back to most recent by timestamp
        running = [pid for pid, info in matching if info.get('status') == 'RUNNING']
        if running:
            return int(max(running, key=lambda p: app_states[p].get('timestamp', 0)))
        # No running entry — return highest PID as last resort
        pids = [pid for pid, _ in matching]
        last_pid = max(pids, key=int) if pids else None
        return int(last_pid) if last_pid else None

    def kill_process(self):
        if self.selected_process:
            os_pid = self.get_os_pid_by_process_id(self.selected_process, shared_utils.RESULT_FILE_PATH)

            # Get process name for logging
            process_name = None
            for process in self.config.get('processes', []):
                if process.get('id') == self.selected_process:
                    process_name = process.get('name')
                    break

            if os_pid:
                # Run kill in background thread to avoid freezing the GUI
                # (graceful_terminate blocks up to 8s, log_event makes network calls)
                def _do_kill():
                    try:
                        shared_utils.graceful_terminate(os_pid)
                        shared_utils.update_process_status_in_json(os_pid, 'KILLED')

                        # Log process kill event to Firebase
                        if self.firebase_client and self.firebase_client.is_connected():
                            try:
                                self.firebase_client.log_event(
                                    action='process_killed',
                                    level='warning',
                                    process_name=process_name,
                                    details=f'Manual kill from GUI - PID: {os_pid}'
                                )
                                logging.info(f"Logged process kill event for {process_name} (PID {os_pid})")
                            except Exception as log_err:
                                logging.error(f"Failed to log kill event: {log_err}")

                    except Exception as e:
                        self.master.after(0, lambda: CTkMessagebox(
                            master=self.master, title="Error",
                            message=f"Failed to kill the process: {e}", icon="cancel"))

                threading.Thread(target=_do_kill, daemon=True).start()
            else:
                CTkMessagebox(master=self.master, title="Error", message="No OS process ID found for the selected process.", icon="cancel")
        else:
            CTkMessagebox(master=self.master, title="Error", message=f"You must select a process to kill it.", icon="cancel")

    def get_status_indicator(self, status):
        """Map status to Unicode dot indicator"""
        if status == 'INACTIVE':
            return '○'  # Hollow dot for inactive
        return '●'      # Solid dot for all active states

    def map_status_to_config(self, status_data, config_data):
        id_to_status = {}
        for pid, info in status_data.items():
            id_ = info.get('id', None)
            status = info.get('status', None)
            if id_ and status:
                id_to_status[id_] = status

        for process in config_data['processes']:
            id_ = process.get('id', None)
            if id_:
                process['status'] = id_to_status.get(id_, "INACTIVE")

        return config_data

    def update_process_list(self):
        import hashlib
        import json

        # Get current keyboard focus (selected entry widget)
        current_focus = str(self.master.focus_get())
        #logging.error(f'current focus = {current_focus}')

        # Get currently selected item from process list
        self.selected_index = self.process_list.curselection()

        status_data = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)

        # Defensive programming: ensure status_data is never None
        if status_data is None:
            status_data = {}

        # Reload config from disk to catch external changes (from Firestore, etc.)
        fresh_config = shared_utils.read_config()
        config_changed_externally = False
        if fresh_config:
            # Check if the selected process config has changed externally (from Firestore)
            if self.selected_process and self.config:
                # Get the current process data for comparison
                old_process = shared_utils.fetch_process_by_id(self.selected_process, self.config)
                new_process = shared_utils.fetch_process_by_id(self.selected_process, fresh_config)

                if old_process and new_process:
                    # Calculate hashes to detect changes
                    old_hash = hashlib.md5(json.dumps(old_process, sort_keys=True).encode()).hexdigest()
                    new_hash = hashlib.md5(json.dumps(new_process, sort_keys=True).encode()).hexdigest()

                    if old_hash != new_hash:
                        config_changed_externally = True
                        logging.debug(f"Detected external config change for process '{new_process.get('name')}'")  # Debug level - fires frequently

            self.config = fresh_config

        updated_config = self.map_status_to_config(status_data, self.config)

        # Format with colored dot indicators
        new_items = []
        new_statuses = []
        for process in updated_config['processes']:
            status = process['status']
            indicator = self.get_status_indicator(status)
            display_text = f"{indicator} {process['name']}"
            color = shared_utils.STATUS_COLORS.get(status, '#94a3b8')
            new_items.append((display_text, color))
            new_statuses.append(status.capitalize())

        if new_items != self.prev_process_list:
            needs_full_rebuild = True
            if self.prev_process_list and len(new_items) == len(self.prev_process_list):
                # Try in-place update: same number of items, just update text/color
                try:
                    for btn, (text, color) in zip(self.process_list.buttons.values(), new_items):
                        btn.configure(text=text, text_color=color)
                    needs_full_rebuild = False
                except Exception:
                    # A button's internal widget is broken — fall through to full rebuild
                    pass

            if needs_full_rebuild:
                # Full rebuild: delete all and recreate
                if self.process_list.size() > 0:
                    self.process_list.delete(0, 'end')
                for text, color in new_items:
                    self.process_list.insert('end', text)
                for btn, (_, color) in zip(self.process_list.buttons.values(), new_items):
                    btn.configure(text_color=color)

            # Update status tooltips on each button
            if not hasattr(self, '_process_tooltips'):
                self._process_tooltips = {}
            for btn, status_text in zip(self.process_list.buttons.values(), new_statuses):
                btn_id = str(btn)
                if btn_id in self._process_tooltips:
                    self._process_tooltips[btn_id].configure(message=status_text)
                else:
                    self._process_tooltips[btn_id] = CTkToolTip(btn, message=status_text, delay=0.4)

            self.prev_process_list = new_items
            self._update_scrollbar_visibility()

            # Reselect process list item after rebuild (if not editing an entry)
            if self.selected_index is not None and (current_focus == '.' or current_focus is None):
                try:
                    self.process_list.activate(self.selected_index)
                except Exception as e:
                    logging.info(e)

        # Auto-refresh displayed fields if config changed externally AND user is not editing
        # This allows Firestore changes to appear immediately without overwriting user input
        if config_changed_externally and self.selected_process:
            # Check if user is currently editing any entry field
            user_is_editing = current_focus and ('entry' in current_focus.lower() or 'text' in current_focus.lower())

            if not user_is_editing:
                # Safe to refresh - user is not actively typing
                process = shared_utils.fetch_process_by_id(self.selected_process, self.config)
                if process:
                    self.refresh_displayed_fields(process)
                    logging.debug(f"Auto-refreshed displayed fields for external config change")  # Debug level - fires frequently

    def update_process_list_periodically(self):
        try:
            self.update_process_list()
        except Exception as e:
            logging.error(f"Error updating process list: {e}")
        self.master.after(1000, self.update_process_list_periodically)  # Schedule next run

    def update_firebase_status_periodically(self):
        """Periodically refresh Firebase connection status from service_status.json"""
        try:
            self.update_firebase_status()
        except Exception as e:
            logging.debug(f"Error updating firebase status: {e}")
        self.master.after(2000, self.update_firebase_status_periodically)  # Schedule next run (every 2s)

    def remove_process(self):
        if self.selected_process:
            process = shared_utils.fetch_process_by_id(self.selected_process, self.config)
            if process:
                process_name = shared_utils.fetch_process_name_by_id(self.selected_process, self.config)
                response = CTkMessagebox(master=self.master, title="Remove Process?", message=f"Are you sure you want to remove {process_name}?", icon="question", option_1="Yes", option_2="No")
                if response.get() == 'Yes':
                    index = shared_utils.get_process_index(self.selected_process)
                    if index is not None:
                        del self.config['processes'][index]
                        shared_utils.save_config(self.config)

                        # Upload to Firestore immediately for fast sync (in background thread)
                        if self.firebase_client:
                            def upload_in_background():
                                try:
                                    # Upload config first
                                    self.firebase_client.upload_config(self._get_config_for_firestore())
                                    logging.debug("Config uploaded to Firestore immediately after process removal")

                                    # Then push metrics so web app sees the change immediately
                                    metrics = shared_utils.get_system_metrics(skip_gpu=True)
                                    self.firebase_client._upload_metrics(metrics)
                                    logging.debug("Metrics pushed to Firestore after process removal")
                                except Exception as e:
                                    logging.error(f"Failed to upload to Firestore: {e}")

                            # Run in background thread so GUI stays responsive
                            upload_thread = threading.Thread(target=upload_in_background, daemon=True)
                            upload_thread.start()

                        self.selected_process = None
                        self._show_detail_fields(False)
                        self.update_process_list()
            else:
                CTkMessagebox(master=self.master, title="Error", message=f"No process found with the name '{self.selected_process}'", icon="cancel")
        else:
            CTkMessagebox(master=self.master, title="Error", message=f"You must select a process to remove it.", icon="cancel")

    def move_up(self):
        if self.selected_process:
            index = shared_utils.get_process_index(self.selected_process)
            if index > 0:
                self.config['processes'][index], self.config['processes'][index-1] = self.config['processes'][index-1], self.config['processes'][index]
                shared_utils.save_config(self.config)

                # Upload to Firestore immediately for fast sync (in background thread)
                if self.firebase_client:
                    def upload_in_background():
                        try:
                            self.firebase_client.upload_config(self._get_config_for_firestore())
                            logging.debug("Config uploaded to Firestore immediately after move up")

                            # Push metrics so web app sees the change immediately
                            metrics = shared_utils.get_system_metrics(skip_gpu=True)
                            self.firebase_client._upload_metrics(metrics)
                            logging.debug("Metrics pushed to Firestore after move up")
                        except Exception as e:
                            logging.error(f"Failed to upload to Firestore: {e}")

                    # Run in background thread so GUI stays responsive
                    upload_thread = threading.Thread(target=upload_in_background, daemon=True)
                    upload_thread.start()

                self.update_process_list()
                self.process_list.activate(index-1)
        else:
            CTkMessagebox(master=self.master, title="Error", message=f"You must select a process move it up in the list.", icon="cancel")

    def move_down(self):
        if self.selected_process:
            index = shared_utils.get_process_index(self.selected_process)
            if index < len(self.config['processes']) - 1:
                self.config['processes'][index], self.config['processes'][index+1] = self.config['processes'][index+1], self.config['processes'][index]
                shared_utils.save_config(self.config)

                # Upload to Firestore immediately for fast sync (in background thread)
                if self.firebase_client:
                    def upload_in_background():
                        try:
                            self.firebase_client.upload_config(self._get_config_for_firestore())
                            logging.debug("Config uploaded to Firestore immediately after move down")

                            # Push metrics so web app sees the change immediately
                            metrics = shared_utils.get_system_metrics(skip_gpu=True)
                            self.firebase_client._upload_metrics(metrics)
                            logging.debug("Metrics pushed to Firestore after move down")
                        except Exception as e:
                            logging.error(f"Failed to upload to Firestore: {e}")

                    # Run in background thread so GUI stays responsive
                    upload_thread = threading.Thread(target=upload_in_background, daemon=True)
                    upload_thread.start()

                self.update_process_list()
                self.process_list.activate(index+1)
        else:
            CTkMessagebox(master=self.master, title="Error", message=f"You must select a process to move it down in the list.", icon="cancel")

    def _bind_right_click_to_list(self):
        """No-op — right-click is now handled globally via bind_all."""
        pass

    def _on_global_right_click(self, event):
        """Handle right-click anywhere — show context menu if click is on a process list item."""
        try:
            self._on_global_right_click_inner(event)
        except Exception as e:
            import traceback
            logging.error(f"[RC-DEBUG] UNCAUGHT EXCEPTION: {e}\n{traceback.format_exc()}")

    def _on_global_right_click_inner(self, event):
        # Get mouse position from Win32 API — bypasses tkinter widget transparency bugs
        import ctypes
        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
        pt = POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        mouse_x, mouse_y = pt.x, pt.y

        logging.debug(f"[RC-DEBUG] GetCursorPos=({mouse_x},{mouse_y}), "
                     f"event.widget={event.widget}, widget_class={event.widget.__class__.__name__}")

        try:
            target = self.master.winfo_containing(mouse_x, mouse_y)
        except Exception as e:
            logging.debug(f"[RC-DEBUG] winfo_containing FAILED: {e}")
            self._dismiss_context_menu()
            return

        if target is None:
            self._dismiss_context_menu()
            return

        # Walk up from the target widget to find a CTkButton
        p = target
        found_btn = None
        while p:
            if isinstance(p, ctk.CTkButton):
                found_btn = p
                break
            try:
                p = p.master
            except Exception:
                break

        if not found_btn:
            self._dismiss_context_menu()
            return

        # Check if the button belongs to the process list using widget path
        found_str = str(found_btn)
        logging.debug(f"[RC-DEBUG] found_btn path={found_str}")

        for idx, btn in enumerate(self.process_list.buttons.values()):
            if str(btn) == found_str or btn is found_btn:
                btn_text = btn.cget('text')
                logging.debug(f"[RC-DEBUG] MATCH idx={idx}, text={btn_text}")
                try:
                    self.process_list.activate(idx)
                except Exception:
                    pass
                self.on_select(btn_text)
                logging.debug(f"[RC-DEBUG] on_select done, showing menu at ({mouse_x},{mouse_y})")
                self._show_process_context_menu(mouse_x, mouse_y)
                logging.debug(f"[RC-DEBUG] menu shown successfully")
                return

        logging.debug(f"[RC-DEBUG] NO MATCH — dismissing")
        self._dismiss_context_menu()

    def _dismiss_context_menu(self, event=None):
        """Close the custom context menu."""
        if self._context_menu_window:
            try:
                self._context_menu_window.destroy()
            except Exception:
                pass
            self._context_menu_window = None
            # Remove the click-outside binding
            if hasattr(self, '_ctx_bind_id') and self._ctx_bind_id:
                try:
                    self.master.unbind("<Button-1>", self._ctx_bind_id)
                except Exception:
                    pass
                self._ctx_bind_id = None

    def _show_process_context_menu(self, mouse_x, mouse_y):
        """Show custom context menu on the process list."""
        self._dismiss_context_menu()

        # Button activation is already handled by _on_global_right_click

        if not self.selected_process:
            return

        index = shared_utils.get_process_index(self.selected_process)
        num_processes = len(self.config.get('processes', []))
        can_move_up = index > 0
        can_move_down = index < num_processes - 1

        # Plain tk.Toplevel avoids CTkToplevel's grab/focus blocking
        menu = tk.Toplevel(self.master)
        menu.overrideredirect(True)
        menu.attributes("-topmost", True)
        menu.configure(bg=shared_utils.FRAME_COLOR)
        self._context_menu_window = menu

        frame = ctk.CTkFrame(menu, fg_color=shared_utils.FRAME_COLOR, corner_radius=0,
                             border_width=1, border_color=shared_utils.BORDER_COLOR)
        frame.pack(fill='both', expand=True)

        btn_opts = {
            "fg_color": "transparent",
            "hover_color": shared_utils.HIGHLIGHT_COLOR,
            "text_color": shared_utils.TEXT_COLOR,
            "anchor": "w",
            "width": 160,
            "height": 32,
            "corner_radius": 4,
            "font": ("Segoe UI", 13),
        }

        def make_action(cmd):
            def action():
                self._dismiss_context_menu()
                self.master.after(50, cmd)
            return action

        # Kill
        ctk.CTkButton(frame, text="  kill process", command=make_action(self.kill_process), **btn_opts).pack(fill='x', padx=4, pady=(4, 0))

        # Separator
        ctk.CTkFrame(frame, fg_color=shared_utils.BORDER_COLOR, height=1).pack(fill='x', padx=8, pady=3)

        # Move Up
        if can_move_up:
            ctk.CTkButton(frame, text="  move up", command=make_action(self.move_up), **btn_opts).pack(fill='x', padx=4)
        else:
            ctk.CTkButton(frame, text="  move up", state="disabled", text_color="#475569",
                          fg_color="transparent", hover_color=shared_utils.FRAME_COLOR, hover=False, anchor="w",
                          width=160, height=32, corner_radius=4, font=("Segoe UI", 13)).pack(fill='x', padx=4)

        # Move Down
        if can_move_down:
            ctk.CTkButton(frame, text="  move down", command=make_action(self.move_down), **btn_opts).pack(fill='x', padx=4)
        else:
            ctk.CTkButton(frame, text="  move down", state="disabled", text_color="#475569",
                          fg_color="transparent", hover_color=shared_utils.FRAME_COLOR, hover=False, anchor="w",
                          width=160, height=32, corner_radius=4, font=("Segoe UI", 13)).pack(fill='x', padx=4)

        # Separator
        ctk.CTkFrame(frame, fg_color=shared_utils.BORDER_COLOR, height=1).pack(fill='x', padx=8, pady=3)

        # Delete (red)
        ctk.CTkButton(frame, text="  delete", command=make_action(self.remove_process),
                      fg_color="transparent", hover_color="#3b1111", text_color="#f87171",
                      anchor="w", width=160, height=32, corner_radius=4,
                      font=("Segoe UI", 13)).pack(fill='x', padx=4, pady=(0, 4))

        # Size and position using actual mouse coords
        menu.update_idletasks()
        mw = menu.winfo_reqwidth()
        mh = menu.winfo_reqheight()
        sw = self.master.winfo_screenwidth()
        sh = self.master.winfo_screenheight()
        x = min(mouse_x, sw - mw - 5)
        y = min(mouse_y, sh - mh - 5)
        menu.geometry(f"{mw}x{mh}+{x}+{y}")

        # Dismiss on any click outside the menu
        def on_click_outside(e):
            try:
                if self._context_menu_window and self._context_menu_window.winfo_exists():
                    mx, my = self._context_menu_window.winfo_rootx(), self._context_menu_window.winfo_rooty()
                    w, h = self._context_menu_window.winfo_width(), self._context_menu_window.winfo_height()
                    if not (mx <= e.x_root <= mx + w and my <= e.y_root <= my + h):
                        self._dismiss_context_menu()
                else:
                    self._dismiss_context_menu()
            except Exception:
                self._dismiss_context_menu()

        self._ctx_bind_id = self.master.bind("<Button-1>", on_click_outside, add=True)
        # Also dismiss on right-click elsewhere
        menu.bind("<Button-3>", lambda e: self._dismiss_context_menu())
        # Escape key
        menu.bind("<Escape>", lambda e: self._dismiss_context_menu())
        menu.focus_set()

    def _update_scrollbar_visibility(self):
        """Toggle between full scrollbar (overflow) and thin 1px divider line (no overflow)."""
        self.process_list.update_idletasks()
        content_height = sum(btn.winfo_reqheight() + 5 for btn in self.process_list.buttons.values())
        visible_height = self.process_list.winfo_height()
        scrollbar = self.process_list._scrollbar
        if content_height > visible_height:
            scrollbar.configure(
                width=12,
                fg_color=self._scrollbar_defaults['fg_color'],
                button_color=self._scrollbar_defaults['button_color'],
                button_hover_color=self._scrollbar_defaults['button_hover_color'],
            )
            scrollbar.grid_configure(padx=(0, 8))
        else:
            scrollbar.configure(
                width=1,
                fg_color=shared_utils.FRAME_COLOR,
                button_color=shared_utils.FRAME_COLOR,
                button_hover_color=shared_utils.FRAME_COLOR,
            )
            scrollbar.grid_configure(padx=(0, 8))

    def on_select(self, process_name):
        # Remove status dot indicator "● " or "○ " from the beginning
        if process_name and len(process_name) >= 2 and process_name[1] == ' ':
            process_name = process_name[2:]
        process_id = shared_utils.fetch_process_id_by_name(process_name, self.config)
        self.selected_process = process_id
        process = shared_utils.fetch_process_by_id(process_id, self.config)
        self._show_detail_fields(True)
        self.refresh_displayed_fields(process)

    def refresh_displayed_fields(self, process):
        """Update all displayed fields from process data (for external changes)"""
        self.name_entry.delete(0, tk.END)
        self.name_entry.insert(0, process.get('name', ''))
        self.exe_path_entry.delete(0, tk.END)
        self.exe_path_entry.insert(0, process.get('exe_path', ''))

        # Map legacy visibility values to new options (backward compatibility)
        visibility_value = process.get('visibility', 'Normal')
        if visibility_value == 'Show':
            visibility_value = 'Normal'
        elif visibility_value == 'Hide':
            visibility_value = 'Hidden'
        self.visibility_menu.set(visibility_value)

        self.priority_menu.set(process.get('priority', 'Normal'))
        self.file_path_entry.delete(0, tk.END)
        self.file_path_entry.insert(0, process.get('file_path', ''))
        self.cwd_entry.delete(0, tk.END)
        self.cwd_entry.insert(0, process.get('cwd', ''))
        self.time_delay_entry.delete(0, tk.END)
        self.time_delay_entry.insert(0, process.get('time_delay', ''))
        self.time_to_init_entry.delete(0, tk.END)
        self.time_to_init_entry.insert(0, process.get('time_to_init', ''))
        self.relaunch_attempts_entry.delete(0, tk.END)
        self.relaunch_attempts_entry.insert(0, process.get('relaunch_attempts', ''))
        # Set launch mode dropdown
        mode = process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')
        display_map = {'off': 'Off', 'always': 'Always On', 'scheduled': 'Scheduled'}
        self.launch_mode_menu.set(display_map.get(mode, 'Off'))
        self._update_schedule_info_label(process)

    # FIREBASE STATUS

    def update_firebase_status(self):
        """Update Firebase connection status indicator and site button."""
        import os
        import json

        # Check if Firebase is enabled in config
        firebase_enabled = self.config.get('firebase', {}).get('enabled', False)
        site_id = self.config.get('firebase', {}).get('site_id', '')

        # Update site display label (truncated, tooltip has full name)
        site_display = site_id if site_id else "Unassigned"
        site_truncated = site_display[:18] + "\u2026" if len(site_display) > 18 else site_display
        self.footer_site_label.configure(text=site_truncated)
        # Update tooltip message (materialized or pending)
        self._footer_site_holder["message"] = f"Site: {site_display}"
        if self._footer_site_holder["tooltip"]:
            self._footer_site_holder["tooltip"].configure(message=f"Site: {site_display}")

        # Read ACTUAL connection status from service_status.json (IPC from service)
        # This is the real-time status, not just token validity
        service_connected = False
        service_status_valid = False

        try:
            status_path = shared_utils.get_data_path('tmp/service_status.json')
            if os.path.exists(status_path):
                # Check file age (stale if > 120 seconds old)
                file_age = time.time() - os.path.getmtime(status_path)
                if file_age <= 120:
                    with open(status_path, 'r') as f:
                        status_data = json.load(f)
                    service_connected = status_data.get('firebase', {}).get('connected', False)
                    service_status_valid = True
        except Exception:
            pass  # Fall back to token check

        # Fall back to token check ONLY if service status file is unavailable
        tokens_valid = False
        if not service_status_valid and firebase_enabled:
            try:
                from auth_manager import AuthManager
                api_base = self.config.get('firebase', {}).get('api_base') or shared_utils.get_api_base_url()
                auth = AuthManager(api_base=api_base)
                try:
                    token = auth.get_valid_token()
                    tokens_valid = bool(token)
                except Exception:
                    tokens_valid = False
            except Exception:
                tokens_valid = False

        # Use service status if available, otherwise fall back to token check
        actually_connected = service_connected if service_status_valid else (tokens_valid and firebase_enabled)

        if firebase_enabled and not site_id:
            # Firebase was enabled but site_id is missing (removed from site)
            self.firebase_status_label.configure(text="removed from site", text_color="#f87171")  # Red
            self.site_button.configure(text="join site", state="normal")
        elif firebase_enabled and actually_connected:
            self.firebase_status_label.configure(text="connected", text_color="#4ade80")  # Green
            self.site_button.configure(text="leave site", state="normal")
        elif firebase_enabled and service_status_valid and not service_connected:
            # Service is running but not connected (internet down, reconnecting, etc.)
            self.firebase_status_label.configure(text="disconnected", text_color="#f87171")  # Red
            self.site_button.configure(text="leave site", state="normal")
        elif firebase_enabled and not tokens_valid:
            self.firebase_status_label.configure(text="authentication required", text_color="#fbbf24")  # Yellow/Warning
            self.site_button.configure(text="join site", state="normal")
        else:
            self.firebase_status_label.configure(text="disabled", text_color="#9ca3af")  # Gray
            self.site_button.configure(text="join site", state="normal")

    def on_site_button_click(self):
        """Route to appropriate handler based on current button state."""
        button_text = self.site_button.cget("text")
        if button_text == "leave site":
            self.on_leave_site_click()
        else:
            self.on_join_site_click()

    def on_leave_site_click(self):
        """Handle Leave Site button click."""
        # Get current site ID for display
        site_id = self.config.get('firebase', {}).get('site_id', 'this site')

        # Show confirmation dialog
        response = CTkMessagebox(
            master=self.master,
            title="Leave Site?",
            message=f"This will remove this machine from '{site_id}'.\n\n"
                   "The following will happen:\n"
                   "• Firebase sync will be disabled\n"
                   "• Machine will be deregistered\n"
                   "• Service must be restarted\n\n"
                   "To re-join a site, you will need to run the owlette installer again.",
            icon="warning",
            option_1="Cancel",
            option_2="leave site",
            width=550
        )

        if response.get() == "leave site":
            # Update status immediately to show we're working (before GUI freezes)
            self.firebase_status_label.configure(text="disabling...", text_color="#fbbf24")  # Yellow
            self.master.update()  # Force GUI update before blocking operation

            try:
                # Disable Firebase and clear site_id FIRST
                # This ensures the service won't recreate the document after we delete it
                if 'firebase' not in self.config:
                    self.config['firebase'] = {}

                self.config['firebase']['enabled'] = False
                self.config['firebase']['site_id'] = ''

                # Save config immediately
                shared_utils.save_config(self.config)
                logging.info("Firebase disabled and site_id cleared in config")

                # Delete the cached Firebase config
                # This prevents service from using stale cached config
                try:
                    cache_path = shared_utils.get_data_path('cache/firebase_cache.json')
                    if os.path.exists(cache_path):
                        os.remove(cache_path)
                        logging.info("Deleted cached Firebase config")
                except Exception as e:
                    logging.warning(f"Failed to delete cached config (non-critical): {e}")

                # CRITICAL: STOP the service BEFORE deleting the machine document
                # This prevents the service from recreating the document while we delete it
                # NSSM is at <install>\tools\nssm.exe (three directories up from this file)
                nssm_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'tools', 'nssm.exe')
                if os.path.exists(nssm_path):
                    try:
                        logging.info("Stopping service to prevent document recreation...")
                        subprocess.run([nssm_path, 'stop', 'OwletteService'],
                                     check=False,
                                     capture_output=True,
                                     timeout=10,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
                        time.sleep(3)  # Give service time to fully stop
                        logging.info("Service stopped successfully")
                    except Exception as e:
                        logging.warning(f"Failed to stop service (will attempt delete anyway): {e}")

                # NOW delete the machine document from Firestore
                # Service is stopped, so it won't recreate the document
                if self.firebase_client and self.firebase_client.connected:
                    try:
                        site_id = self.config.get('firebase', {}).get('site_id', '')
                        machine_ref = self.firebase_client.db.collection('sites').document(site_id)\
                            .collection('machines').document(self.firebase_client.machine_id)

                        # Delete the entire machine document
                        machine_ref.delete()
                        logging.info("Machine document permanently deleted from Firestore")
                        time.sleep(0.5)  # Give network time to complete the deletion
                    except Exception as e:
                        logging.warning(f"Failed to delete machine from Firestore (non-critical): {e}")

                # Stop GUI's Firebase client
                if self.firebase_client:
                    try:
                        self.firebase_client.stop()
                        logging.info("Firebase client stopped")
                    except Exception as e:
                        logging.error(f"Error stopping Firebase client: {e}")

                # Update status in GUI
                self.update_firebase_status()

                # Start the service again (with Firebase disabled)
                if os.path.exists(nssm_path):
                    try:
                        logging.info("Starting service with Firebase disabled...")
                        subprocess.run([nssm_path, 'start', 'OwletteService'],
                                     check=False,
                                     capture_output=True,
                                     timeout=10,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
                        time.sleep(2)  # Give service time to start
                        logging.info("Service restarted successfully")
                    except Exception as e:
                        logging.warning(f"Failed to restart service (non-critical): {e}")
                else:
                    logging.warning(f"NSSM not found at {nssm_path}, service was not restarted")

                # Show simple success message
                CTkMessagebox(
                    master=self.master,
                    title="Left Site Successfully",
                    message="This machine has been removed from the site and is no longer monitored.\n\nThe owlette service has been restarted.",
                    icon="check",
                    width=600
                )

            except Exception as e:
                logging.error(f"Error leaving site: {e}")
                CTkMessagebox(
                    master=self.master,
                    title="Error",
                    message=f"Failed to leave site:\n{str(e)}",
                    icon="cancel"
                )

    def on_join_site_click(self):
        """Handle Join Site button click - re-authenticate to a site."""
        # Show confirmation dialog
        response = CTkMessagebox(
            master=self.master,
            title="Join Site?",
            message="This will open your browser to authenticate with a site.\n\n"
                   "Steps:\n"
                   "1. Log in to your owlette account\n"
                   "2. Select or create a site\n"
                   "3. Authorize this machine\n\n"
                   "The service will restart after authentication completes.",
            icon="question",
            option_1="Cancel",
            option_2="join site",
            width=550
        )

        if response.get() != "join site":
            return

        # Update status immediately to show we're connecting (before any blocking operations)
        self.firebase_status_label.configure(text="connecting...", text_color="#fbbf24")  # Yellow
        self.master.update()  # Force GUI update before blocking operation

        # Get setup URL based on environment setting
        setup_url = shared_utils.get_setup_url()

        # Show loading dialog (not topmost so browser is accessible)
        loading_dialog = CTkMessagebox(
            master=self.master,
            title="joining site...",
            message="Opening browser for authentication.\n\nPlease complete the steps in your browser.\n\nThis window will close automatically when done.",
            icon=None,
            option_1="Cancel",
            width=550,
            topmost=False
        )

        # Run OAuth flow in background thread
        def run_oauth_thread():
            try:
                # Import configure_site module
                import configure_site

                # Run OAuth flow (no console prompts for GUI usage)
                success, message, site_id = configure_site.run_oauth_flow(
                    setup_url=setup_url,
                    timeout_seconds=300,  # 5 minutes
                    show_prompts=False  # No console output for GUI
                )

                # Close loading dialog
                self.master.after(0, loading_dialog.destroy)

                if success:
                    logging.info(f"Successfully joined site: {site_id}")

                    # Reload config to get new site information
                    self.config = shared_utils.load_config()

                    # Restart service to connect with new site
                    nssm_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'tools', 'nssm.exe')
                    if os.path.exists(nssm_path):
                        try:
                            logging.info("Restarting service with new site configuration...")
                            subprocess.run([nssm_path, 'stop', 'OwletteService'],
                                         check=False,
                                         capture_output=True,
                                         timeout=10,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
                            time.sleep(3)
                            subprocess.run([nssm_path, 'start', 'OwletteService'],
                                         check=False,
                                         capture_output=True,
                                         timeout=10,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
                            time.sleep(2)
                            logging.info("Service restarted successfully")
                        except Exception as e:
                            logging.warning(f"Failed to restart service: {e}")

                    # Update Firebase client and status
                    self._reinitialize_firebase()

                    # Show success message
                    self.master.after(0, lambda: CTkMessagebox(
                        master=self.master,
                        title="Joined Site Successfully",
                        message=f"This machine has been registered to site: {site_id}\n\n"
                               f"The service is now connecting to Firebase.\n\n"
                               f"The status will update automatically once connected.",
                        icon="check",
                        width=600
                    ))
                else:
                    logging.error(f"Failed to join site: {message}")
                    # Show error message
                    self.master.after(0, lambda: CTkMessagebox(
                        master=self.master,
                        title="Failed to Join Site",
                        message=f"Could not complete authentication:\n\n{message}\n\nPlease try again or check the logs for details.",
                        icon="cancel",
                        width=600
                    ))

            except Exception as e:
                logging.error(f"Error in OAuth flow: {e}")
                self.master.after(0, loading_dialog.destroy)
                self.master.after(0, lambda: CTkMessagebox(
                    master=self.master,
                    title="Error",
                    message=f"An unexpected error occurred:\n\n{str(e)}",
                    icon="cancel",
                    width=600
                ))

        # Start OAuth thread
        oauth_thread = threading.Thread(target=run_oauth_thread, daemon=True)
        oauth_thread.start()

    def _reinitialize_firebase(self):
        """Reinitialize Firebase status after configuration change.

        Note: The GUI does NOT need its own Firebase client for sync.
        The Windows service handles all Firebase syncing. The GUI just
        needs to update the status display.
        """
        try:
            # Stop old client if exists (we don't need it for status updates)
            if hasattr(self, 'firebase_client') and self.firebase_client:
                try:
                    self.firebase_client.stop()
                    self.firebase_client = None
                except:
                    pass

            # Reload config
            self.config = shared_utils.load_config()

            # Update site_id for status display
            if self.config.get('firebase', {}).get('enabled'):
                self.site_id = self.config['firebase'].get('site_id', '')
                logging.info(f"Firebase config updated for site: {self.site_id}")

            # Update status display (the service handles actual sync)
            self.update_firebase_status()

        except Exception as e:
            logging.error(f"Failed to reinitialize Firebase: {e}")

    def restart_service(self):
        """Restart the owlette service."""
        try:
            import win32serviceutil
            service_name = 'OwletteService'

            # Stop the service
            win32serviceutil.StopService(service_name)
            logging.info(f"Stopping {service_name}...")
            time.sleep(2)

            # Start the service
            win32serviceutil.StartService(service_name)
            logging.info(f"Starting {service_name}...")

            CTkMessagebox(
                master=self.master,
                title="Service Restarted",
                message="The owlette service has been restarted successfully.",
                icon="check"
            )
        except Exception as e:
            logging.error(f"Error restarting service: {e}")
            CTkMessagebox(
                master=self.master,
                title="Error",
                message=f"Failed to restart service:\n{str(e)}\n\nPlease restart manually.",
                icon="cancel"
            )

    # UI

    def defocus_entry(self, event):
        """Defocus entry fields when clicking on the background"""
        widget = self.master.winfo_containing(event.x_root, event.y_root)
        if 'ctkframe' in str(widget):
            self.master.focus_set()  # Transfers focus to the root window (triggers FocusOut auto-save)

    def _open_tec_website(self):
        """Open TEC website in default browser"""
        import webbrowser
        webbrowser.open("https://tec.design")

    def open_config(self):
        """Open config.json in default text editor"""
        try:
            config_path = shared_utils.get_data_path('config/config.json')
            if os.path.exists(config_path):
                os.startfile(config_path)
                logging.info(f"Opened config file: {config_path}")
            else:
                CTkMessagebox(
                    master=self.master,
                    title="File Not Found",
                    message=f"Config file not found at:\n{config_path}",
                    icon="cancel"
                )
        except Exception as e:
            logging.error(f"Error opening config file: {e}")
            CTkMessagebox(
                master=self.master,
                title="Error",
                message=f"Failed to open config file:\n{str(e)}",
                icon="cancel"
            )

    def open_logs(self):
        """Open logs folder in Windows Explorer"""
        try:
            logs_path = shared_utils.get_data_path('logs')
            if os.path.exists(logs_path):
                os.startfile(logs_path)
                logging.info(f"Opened logs folder: {logs_path}")
            else:
                CTkMessagebox(
                    master=self.master,
                    title="Folder Not Found",
                    message=f"Logs folder not found at:\n{logs_path}",
                    icon="cancel"
                )
        except Exception as e:
            logging.error(f"Error opening logs folder: {e}")
            CTkMessagebox(
                master=self.master,
                title="Error",
                message=f"Failed to open logs folder:\n{str(e)}",
                icon="cancel"
            )

    # OVERFLOW MENU

    def _toggle_overflow_menu(self):
        """Toggle the floating overflow menu above the ··· button."""
        if self._overflow_panel and self._overflow_panel.winfo_exists():
            self._close_overflow_menu()
            return

        self._overflow_panel = ctk.CTkToplevel(self.master)
        self._overflow_panel.overrideredirect(True)
        self._overflow_panel.configure(fg_color=shared_utils.FRAME_COLOR)
        self._overflow_panel.attributes('-topmost', True)

        # Inner frame with border
        inner = ctk.CTkFrame(
            self._overflow_panel,
            fg_color=shared_utils.FRAME_COLOR,
            border_color=shared_utils.BORDER_COLOR,
            border_width=1,
            corner_radius=shared_utils.CORNER_RADIUS
        )
        inner.pack(fill='both', expand=True, padx=0, pady=0)

        menu_items = [
            ("config", self.open_config),
            ("logs", self.open_logs),
            ("docs", self._open_docs),
            ("feedback / bug", self._open_feedback_dialog),
        ]

        pad = 6  # equal padding on all sides inside the border
        for label, command in menu_items:
            btn = ctk.CTkButton(
                inner, text=label, anchor='w',
                width=120, height=28,
                fg_color='transparent',
                hover_color=shared_utils.BUTTON_HOVER_COLOR,
                text_color=shared_utils.TEXT_COLOR,
                font=("", 11),
                corner_radius=4,
                command=lambda cmd=command: self._overflow_action(cmd)
            )
            btn.pack(fill='x', padx=pad, pady=(pad if label == menu_items[0][0] else 1, pad if label == menu_items[-1][0] else 1))

        # Position above the ··· button
        self.overflow_button.update_idletasks()
        btn_x = self.overflow_button.winfo_rootx()
        btn_y = self.overflow_button.winfo_rooty()
        panel_height = len(menu_items) * 30 + pad * 2
        panel_width = 128
        x = btn_x + self.overflow_button.winfo_width() - panel_width
        y = btn_y - panel_height - 4
        self._overflow_panel.geometry(f"{panel_width}x{panel_height}+{x}+{y}")

        # Auto-dismiss on click outside or focus loss
        self._overflow_panel.bind('<FocusOut>', lambda e: self.master.after(100, self._close_overflow_menu_safe))
        self.master.bind('<Button-1>', self._on_click_outside_overflow, add='+')

    def _overflow_action(self, command):
        """Execute a menu action and close the panel."""
        self._close_overflow_menu()
        command()

    def _on_click_outside_overflow(self, event):
        """Close overflow menu if click is outside it."""
        if self._overflow_panel and self._overflow_panel.winfo_exists():
            try:
                mx, my = self._overflow_panel.winfo_rootx(), self._overflow_panel.winfo_rooty()
                mw, mh = self._overflow_panel.winfo_width(), self._overflow_panel.winfo_height()
                if not (mx <= event.x_root <= mx + mw and my <= event.y_root <= my + mh):
                    self._close_overflow_menu()
            except Exception:
                pass

    def _close_overflow_menu_safe(self):
        """Close overflow menu if it exists and doesn't have focus."""
        if self._overflow_panel and self._overflow_panel.winfo_exists():
            try:
                if self.master.focus_get() is None or not str(self.master.focus_get()).startswith(str(self._overflow_panel)):
                    self._close_overflow_menu()
            except Exception:
                self._close_overflow_menu()

    def _close_overflow_menu(self):
        """Destroy the overflow menu panel."""
        if self._overflow_panel and self._overflow_panel.winfo_exists():
            self._overflow_panel.destroy()
        self._overflow_panel = None
        try:
            self.master.unbind('<Button-1>')
            # Re-bind the global right-click handler that may have been affected
            self.master.bind_all("<Button-3>", self._on_global_right_click)
        except Exception:
            pass

    def _open_docs(self):
        """Open the owlette documentation in the default browser."""
        import webbrowser
        webbrowser.open("https://theexperiential.github.io/owlette/")
        logging.info("Opened documentation URL")

    def _open_feedback_dialog(self):
        """Spawn the feedback/bug report dialog using bundled pythonw."""
        try:
            pythonw = os.path.join(shared_utils.get_data_path('python'), 'pythonw.exe')
            if not os.path.exists(pythonw):
                pythonw = 'pythonw'  # fall back to PATH
            subprocess.Popen(
                [pythonw, shared_utils.get_path('report_issue.py')],
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            logging.info(f"Spawned feedback dialog via {pythonw}")
        except Exception as e:
            logging.error(f"Failed to open feedback dialog: {e}")

    # SYSTEM/MISC

    def check_service_is_running(self, service_name):
        try:
            # Lazy import win32serviceutil only when checking service
            import win32serviceutil
            status = win32serviceutil.QueryServiceStatus(service_name)[1]
            if status == 4:  # 4 means the service is running
                return True
            else:
                return False
        except Exception as e:
            print(f"An error occurred: {e}")
            return None

    def start_service(self):
        try:
            subprocess.Popen(
                ["pythonw", shared_utils.get_path("start_service.py")],
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            print("Service started successfully.")
        except Exception as e:
            print(f"Failed to start service: {e}")

if __name__ == "__main__":
    # Initialize logging with configurable log level
    log_level = shared_utils.get_log_level_from_config()
    shared_utils.initialize_logging("gui", level=log_level)
    try:
        root = ctk.CTk()
        app = OwletteConfigApp(root)
        root.mainloop()
    except Exception:
        logging.exception("GUI crashed with unhandled exception")
    finally:
        logging.info("GUI process exiting")
        # Force-exit the process — pythonw can hang if any non-daemon thread
        # or background I/O (e.g. logging, firebase) keeps the interpreter alive
        os._exit(0)