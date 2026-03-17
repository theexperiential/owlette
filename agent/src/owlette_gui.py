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

class OwletteConfigApp:

    def __init__(self, master):
        self.master = master

        # Initialize basic window properties
        hostname = socket.gethostname()
        self.master.title(f"Owlette: {hostname}")

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
            self.relaunch_attempts_entry.insert(0, 3)

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

                logging.info(f"Service status: {'Running' if is_running else 'Started'}")
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
                    # Firebase is disabled - still update status to show "Disabled"
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
            # Start in collapsed state (narrow window crops out PROCESS DETAILS completely)
            shared_utils.center_window(self.master, 270, 450)
            self.master.minsize(270, 450)
            self.details_toggle_button.configure(text=">>")
            self.footer_label.grid_remove()  # Hide footer
            self.site_label_left.pack(side='left', expand=True)  # Show Site in center
            self.site_id_label.pack_forget()  # Hide Site in right panel
        else:
            # Start in expanded state
            shared_utils.center_window(self.master, 1300, 450)
            self.master.minsize(1300, 450)
            self.details_toggle_button.configure(text="<<")
            self.site_label_left.pack_forget()  # Hide Site from header
            # Footer and site_id_label are already visible by default

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
            logging.info("Applied Windows 11 dark theme")
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
        self.process_list_frame = ctk.CTkFrame(master=self.master, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.WINDOW_COLOR, border_width=0, corner_radius=12)
        self.process_list_frame.grid(row=0, column=0, sticky='nsew', rowspan=10, columnspan=3, padx=(10, 0), pady=(10, 0))

        # Header container frame (spans columns 0-2, row 0)
        self.header_frame = ctk.CTkFrame(self.master, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR)
        self.header_frame.grid(row=0, column=0, columnspan=3, sticky='ew', padx=(20, 2), pady=(20, 0))

        # PROCESSES label (left aligned)
        self.process_list_label = ctk.CTkLabel(self.header_frame, text="Processes", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.process_list_label.pack(side='left')

        # Toggle button (right aligned)
        self.details_toggle_button = ctk.CTkButton(self.header_frame, text="<<", command=self.toggle_details_panel, width=30, height=24, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.details_toggle_button.pack(side='right', padx=(0, 5))

        # Site label (center - only visible when collapsed)
        site_id = self.config.get('firebase', {}).get('site_id', '')
        site_display = site_id if site_id else "Unassigned"
        self.site_label_left = ctk.CTkLabel(self.header_frame, text=f"Site: {site_display}", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color="#60a5fa", font=("", 12))
        self.site_label_left.pack(side='left', expand=True)  # expand=True centers it in remaining space
        self.site_label_left.pack_forget()  # Hidden initially if starting expanded

        # Create a Listbox to display the list of processes
        self.process_list = CTkListbox(self.master, command=self.on_select)
        self.process_list.grid(row=1, column=0, columnspan=3, rowspan=7, sticky='nsew', padx=(20, 10), pady=10)
        self.process_list.configure(highlight_color="#1e3a5f", hover_color=shared_utils.BUTTON_HOVER_COLOR, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color="#334155", border_width=1)
        # Adjust scrollbar padding to shift it left
        self.process_list._scrollbar.grid_configure(padx=(0, 8))

        # Button row 1: New/Up/Kill
        self.new_button = ctk.CTkButton(self.master, text="New", command=self.new_process, width=60, fg_color=shared_utils.BUTTON_IMPORTANT_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.new_button.grid(row=8, column=0, sticky='w', padx=(20, 0), pady=(5, 5))

        self.up_button = ctk.CTkButton(self.master, text="↑", command=self.move_up, width=60, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.up_button.grid(row=8, column=1, sticky='', padx=5, pady=(5, 5))

        self.kill_button = ctk.CTkButton(self.master, text="Kill", command=self.kill_process, width=60, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.kill_button.grid(row=8, column=2, sticky='e', padx=5, pady=(5, 5))

        # Button row 2: Down arrow/Delete
        self.down_button = ctk.CTkButton(self.master, text="↓", command=self.move_down, width=60, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.down_button.grid(row=9, column=1, sticky='', padx=5, pady=(5, 15))

        self.remove_button = ctk.CTkButton(self.master, text="Delete", command=self.remove_process, width=80, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.remove_button.grid(row=9, column=2, sticky='e', padx=5, pady=(5, 15))

        # Firebase status indicator (left side of row 10)
        self.firebase_status_label = ctk.CTkLabel(self.master, text="", fg_color=shared_utils.WINDOW_COLOR, bg_color=shared_utils.WINDOW_COLOR, text_color=shared_utils.TEXT_COLOR, font=("", 11))
        self.firebase_status_label.grid(row=10, column=0, columnspan=2, sticky='sw', padx=(20, 0), pady=(5, 5))

        # Site management button (Join/Leave Site - changes based on connection state)
        self.site_button = ctk.CTkButton(
            self.master,
            text="Join Site",
            command=self.on_site_button_click,
            width=100,
            height=24,
            fg_color=shared_utils.BUTTON_COLOR,
            hover_color=shared_utils.BUTTON_HOVER_COLOR,
            font=("", 11),
            bg_color=shared_utils.WINDOW_COLOR,
            corner_radius=6
        )
        self.site_button.grid(row=10, column=2, sticky='se', padx=5, pady=(5, 5))

        # Footer label (perfectly centered in row 10)
        footer_text = "Made with ♥ in California by TEC"
        self.footer_label = ctk.CTkLabel(self.master, text=footer_text, fg_color=shared_utils.WINDOW_COLOR, bg_color=shared_utils.WINDOW_COLOR, text_color="#60a5fa", font=("", 11))
        self.footer_label.grid(row=10, column=0, columnspan=8, sticky='', padx=0, pady=(5, 5))
        # Lift buttons above the footer label (its columnspan=8 overlaps them, causing flash on resize)
        self.site_button.lift()
        self.firebase_status_label.lift()
        # Make TEC text clickable
        self.footer_label.configure(cursor="hand2")
        self.footer_label.bind("<Button-1>", lambda _: self._open_tec_website())

        # Config button (far right, before Logs)
        self.config_button = ctk.CTkButton(
            self.master,
            text="Config",
            command=self.open_config,
            width=70,
            height=24,
            fg_color=shared_utils.BUTTON_COLOR,
            hover_color=shared_utils.BUTTON_HOVER_COLOR,
            font=("", 11),
            bg_color=shared_utils.WINDOW_COLOR,
            corner_radius=6
        )
        self.config_button.grid(row=10, column=7, sticky='e', padx=(0, 230), pady=(5, 5))

        # Logs button (far right, before version)
        self.logs_button = ctk.CTkButton(
            self.master,
            text="Logs",
            command=self.open_logs,
            width=70,
            height=24,
            fg_color=shared_utils.BUTTON_COLOR,
            hover_color=shared_utils.BUTTON_HOVER_COLOR,
            font=("", 11),
            bg_color=shared_utils.WINDOW_COLOR,
            corner_radius=6
        )
        self.logs_button.grid(row=10, column=7, sticky='e', padx=(0, 150), pady=(5, 5))

        # Version label (far right of row 10)
        self.version_label = ctk.CTkLabel(self.master, text=f"v{shared_utils.APP_VERSION}", fg_color=shared_utils.WINDOW_COLOR, bg_color=shared_utils.WINDOW_COLOR, text_color=shared_utils.TEXT_COLOR, font=("", 11))
        self.version_label.grid(row=10, column=7, sticky='se', padx=(0, 20), pady=(5, 5))

        # PROCESS DETAILS (RIGHT SIDE)
        # Create frame for process details
        self.process_details_frame = ctk.CTkFrame(master=self.master, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.WINDOW_COLOR, border_width=0, corner_radius=12)
        self.process_details_frame.grid(row=0, column=4, sticky='news', rowspan=10, columnspan=5, padx=(5, 10), pady=(10, 0))

        # Create a label for the process details
        self.process_details_label = ctk.CTkLabel(self.master, text="Process Details", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.process_details_label.grid(row=0, column=4, columnspan=2, sticky='w', padx=(20, 10), pady=(20, 0))

        # Create hostname and site ID labels in same row, right-aligned
        hostname = socket.gethostname()
        site_id = self.config.get('firebase', {}).get('site_id', '')

        # Show "Unassigned" if no site_id
        site_display = site_id if site_id else "Unassigned"

        # Container frame for hostname and site ID (right-aligned)
        self.machine_info_frame = ctk.CTkFrame(self.master, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR)
        self.machine_info_frame.grid(row=0, column=6, columnspan=2, sticky='e', padx=(10, 20), pady=(20, 0))

        # Hostname label with "Machine:" prefix
        self.hostname_label = ctk.CTkLabel(self.machine_info_frame, text=f"Machine: {hostname}", fg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR, font=("", 12, "bold"))
        self.hostname_label.pack(side='right')

        # Site ID label (same size, lighter color) - pack on the right side (appears to left of hostname)
        self.site_id_label = ctk.CTkLabel(self.machine_info_frame, text=f"Site: {site_display}", fg_color=shared_utils.FRAME_COLOR, text_color="#60a5fa", font=("", 12))
        self.site_id_label.pack(side='right', padx=(0, 15))

        # Create a toggle switch for process
        self.autolaunch_label = ctk.CTkLabel(self.master, text="Autolaunch:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.autolaunch_label.grid(row=1, column=4, sticky='e', padx=5, pady=5)
        self.autolaunch_toggle = ctk.CTkSwitch(master=self.master, text="", command=self.toggle_launch_process, onvalue="on", offvalue="off")
        self.autolaunch_toggle.grid(row=1, column=5, sticky='w', padx=10, pady=5)
        self.autolaunch_toggle.configure(bg_color=shared_utils.FRAME_COLOR, fg_color='#475569', progress_color=shared_utils.BUTTON_IMPORTANT_COLOR)
        self.autolaunch_toggle.select()

        # Create Name of process field
        self.name_label = ctk.CTkLabel(self.master, text="Name:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.name_label.grid(row=2, column=4, sticky='e', padx=5, pady=5)
        self.name_entry = ctk.CTkEntry(self.master, placeholder_text="Name of your process", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color="#334155", border_width=1, corner_radius=6)
        self.name_entry.grid(row=2, column=5, columnspan=3, sticky='ew', padx=(10, 20), pady=5)

        # Create Exe path field
        self.exe_path_label = ctk.CTkLabel(self.master, text="Exe:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.exe_path_label.grid(row=3, column=4, sticky='e', padx=5, pady=5)
        self.exe_browse_button = ctk.CTkButton(self.master, text="Browse", command=self.browse_exe, width=80, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.exe_browse_button.grid(row=3, column=5, sticky='w', padx=(10, 5), pady=5)
        self.exe_path_entry = ctk.CTkEntry(self.master, placeholder_text="The full path to your executable (application)", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color="#334155", border_width=1, corner_radius=6)
        self.exe_path_entry.grid(row=3, column=6, columnspan=2, sticky='ew', padx=(5, 20), pady=5)

        # Create File path / cmd line args
        self.file_path_label = ctk.CTkLabel(self.master, text="Path / Args:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.file_path_label.grid(row=4, column=4, sticky='e', padx=5, pady=5)
        self.file_browse_button = ctk.CTkButton(self.master, text="Browse", command=self.browse_file, width=80, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.file_browse_button.grid(row=4, column=5, sticky='w', padx=(10, 5), pady=5)
        self.file_path_entry = ctk.CTkEntry(self.master, placeholder_text="The full path to your document or command line arguments", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color="#334155", border_width=1, corner_radius=6)
        self.file_path_entry.grid(row=4, column=6, columnspan=2, sticky='ew', padx=(5, 20), pady=5)

        # Create CWD path field
        self.cwd_label = ctk.CTkLabel(self.master, text="CWD:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.cwd_label.grid(row=5, column=4, sticky='e', padx=5, pady=5)
        self.cwd_browse_button = ctk.CTkButton(self.master, text="Browse", command=self.browse_cwd, width=80, fg_color=shared_utils.BUTTON_COLOR, hover_color=shared_utils.BUTTON_HOVER_COLOR, bg_color=shared_utils.FRAME_COLOR, corner_radius=6)
        self.cwd_browse_button.grid(row=5, column=5, sticky='w', padx=(10, 5), pady=5)
        self.cwd_entry = ctk.CTkEntry(self.master, placeholder_text="The working directory for your process", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, border_color="#334155", border_width=1, corner_radius=6)
        self.cwd_entry.grid(row=5, column=6, columnspan=2, sticky='ew', padx=(5, 20), pady=5)

        # Create Time delay label and field
        self.time_delay_label = ctk.CTkLabel(self.master, text="Delay (sec):", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.time_delay_label.grid(row=6, column=4, sticky='e', padx=5, pady=5)
        self.time_delay_entry = ctk.CTkEntry(self.master, placeholder_text="0", width=80, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR, border_color="#334155", border_width=1, corner_radius=6)
        self.time_delay_entry.grid(row=6, column=5, sticky='w', padx=(10, 5), pady=5)

        # Create Priority dropdown
        self.priority_label = ctk.CTkLabel(self.master, text="Priority:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.priority_label.grid(row=6, column=6, sticky='e', padx=5, pady=5)
        self.priority_options = ["Low", "Normal", "High", "Realtime"]
        self.priority_menu = ctk.CTkOptionMenu(self.master, values=self.priority_options, command=self.update_selected_process)
        self.priority_menu.configure(fg_color=shared_utils.BUTTON_COLOR, bg_color=shared_utils.FRAME_COLOR, button_color=shared_utils.BUTTON_IMPORTANT_COLOR, button_hover_color=shared_utils.BUTTON_HOVER_COLOR, width=140, dropdown_fg_color=shared_utils.BUTTON_COLOR, corner_radius=6)
        self.priority_menu.grid(row=6, column=7, sticky='w', padx=(5, 20), pady=5)
        self.priority_menu.set('Normal')

        # Create a label and entry for "Time to Initialize"
        self.time_to_init_label = ctk.CTkLabel(self.master, text="Wait (sec):", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.time_to_init_label.grid(row=7, column=4, sticky='e', padx=5, pady=5)
        self.time_to_init_entry = ctk.CTkEntry(self.master, placeholder_text="10", width=80, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR, border_color="#334155", border_width=1, corner_radius=6)
        self.time_to_init_entry.grid(row=7, column=5, sticky='w', padx=(10, 5), pady=5)

        # Create Visibility dropdown
        self.visibility_label = ctk.CTkLabel(self.master, text="Visibility:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.visibility_label.grid(row=7, column=6, sticky='e', padx=5, pady=5)
        self.visibility_options = ["Normal", "Hidden"]
        self.visibility_menu = ctk.CTkOptionMenu(self.master, values=self.visibility_options, command=self.update_selected_process)
        self.visibility_menu.configure(width=140, fg_color=shared_utils.BUTTON_COLOR, bg_color=shared_utils.FRAME_COLOR, button_color=shared_utils.BUTTON_IMPORTANT_COLOR, button_hover_color=shared_utils.BUTTON_HOVER_COLOR, dropdown_fg_color=shared_utils.BUTTON_COLOR, corner_radius=6)
        self.visibility_menu.grid(row=7, column=7, sticky='w', padx=(5, 20), pady=5)
        self.visibility_menu.set('Normal')

        # Create a label and entry for "Restart Attempts"
        self.relaunch_attempts_label = ctk.CTkLabel(self.master, text="Attempts:", fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR)
        self.relaunch_attempts_label.grid(row=8, column=4, sticky='e', padx=5, pady=5)
        self.relaunch_attempts_entry = ctk.CTkEntry(self.master, placeholder_text="3", width=80, fg_color=shared_utils.FRAME_COLOR, bg_color=shared_utils.FRAME_COLOR, text_color=shared_utils.TEXT_COLOR, border_color="#334155", border_width=1, corner_radius=6)
        self.relaunch_attempts_entry.grid(row=8, column=5, sticky='w', padx=(10, 5), pady=5)

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

        # Tooltips
        tooltip_opts = {"delay": 0.5, "alpha": 0.95, "corner_radius": 6}
        CTkToolTip(self.autolaunch_toggle, message="Automatically launch and monitor this process", **tooltip_opts)
        CTkToolTip(self.name_entry, message="Display name for this process", **tooltip_opts)
        CTkToolTip(self.exe_path_entry, message="Full path to the executable (.exe)", **tooltip_opts)
        CTkToolTip(self.exe_browse_button, message="Browse for an executable file", **tooltip_opts)
        CTkToolTip(self.file_path_entry, message="A file to open with the executable (e.g. a .toe project),\nor command line arguments (e.g. --verbose --port 8080)", **tooltip_opts)
        CTkToolTip(self.file_browse_button, message="Browse for a file to pass to the executable", **tooltip_opts)
        CTkToolTip(self.cwd_entry, message="Working directory for the process", **tooltip_opts)
        CTkToolTip(self.cwd_browse_button, message="Browse for a working directory", **tooltip_opts)
        CTkToolTip(self.time_delay_entry, message="Seconds to wait before launching this process on startup", **tooltip_opts)
        CTkToolTip(self.priority_menu, message="CPU priority level for the process", **tooltip_opts)
        CTkToolTip(self.time_to_init_entry, message="Seconds to wait after launch before monitoring starts", **tooltip_opts)
        CTkToolTip(self.visibility_menu, message="Whether the process window is visible or hidden", **tooltip_opts)
        CTkToolTip(self.relaunch_attempts_entry, message="Max restart attempts before giving up (0 = unlimited)", **tooltip_opts)
        CTkToolTip(self.new_button, message="Add a new process", **tooltip_opts)
        CTkToolTip(self.up_button, message="Move process up in launch order", **tooltip_opts)
        CTkToolTip(self.down_button, message="Move process down in launch order", **tooltip_opts)
        CTkToolTip(self.kill_button, message="Force stop the selected process", **tooltip_opts)
        CTkToolTip(self.remove_button, message="Remove process from the list", **tooltip_opts)
        CTkToolTip(self.details_toggle_button, message="Show/hide process details panel", **tooltip_opts)
        CTkToolTip(self.config_button, message="Open configuration file", **tooltip_opts)
        CTkToolTip(self.logs_button, message="Open log file", **tooltip_opts)
        CTkToolTip(self.site_button, message="Join or leave a cloud site for remote management", **tooltip_opts)

        # Make columns stretchable
        # Left side (process list): columns 0-2 - VERY high weight to dominate space
        # self.master.grid_columnconfigure(0, weight=1, minsize=120)
        # self.master.grid_columnconfigure(1, weight=100, minsize=120)
        # self.master.grid_columnconfigure(2, weight=100, minsize=120)
        # Separator: column 3
        self.master.grid_columnconfigure(3, weight=0, minsize=10)
        # Right side (process details): columns 4-7
        self.master.grid_columnconfigure(4, weight=1)  # Labels column
        self.master.grid_columnconfigure(5, weight=0)  # First input/browse column
        self.master.grid_columnconfigure(6, weight=2)  # Second label/input column
        self.master.grid_columnconfigure(7, weight=2)  # Second input column

        # No row weight configuration needed - keeps layout compact

    def toggle_details_panel(self):
        """Toggle collapse/expand window (crop to show/hide right panel)"""
        # Get current window position to preserve it
        geometry = self.master.geometry()  # e.g., "1300x450+100+200"
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
            # EXPAND: Resize window to show everything
            self.details_toggle_button.configure(text="<<")
            self.footer_label.grid()  # Show footer
            self.site_label_left.pack_forget()  # Hide Site from header center
            self.site_id_label.pack(side='right', padx=(0, 15))  # Show Site in right panel

            if x and y:
                self.master.geometry(f'1300x450+{x}+{y}')
            else:
                shared_utils.center_window(self.master, 1300, 450)

            self.master.minsize(1300, 450)
            self.details_collapsed = False
        else:
            # COLLAPSE: Resize window to crop and show only left panel
            self.details_toggle_button.configure(text=">>")
            self.footer_label.grid_remove()  # Hide footer
            self.site_id_label.pack_forget()  # Hide Site from right panel
            self.site_label_left.pack(side='left', expand=True)  # Show Site in header center

            if x and y:
                self.master.geometry(f'270x450+{x}+{y}')
            else:
                shared_utils.center_window(self.master, 270, 450)

            self.master.minsize(270, 450)
            self.details_collapsed = True

        # Save state to config
        if 'gui' not in self.config:
            self.config['gui'] = {}
        self.config['gui']['details_collapsed'] = self.details_collapsed
        shared_utils.save_config(self.config)

        self.master.update()

    # PROCESS HANDLING

    def toggle_launch_process(self):
        if self.selected_process:
            index = shared_utils.get_process_index(self.selected_process)
            current_state = self.config['processes'][index].get('autolaunch', False)
            new_state = not current_state

            # If turning ON, validate required fields
            if new_state:
                name = self.config['processes'][index].get('name', '')
                exe_path = self.config['processes'][index].get('exe_path', '').strip()

                if not name or not exe_path:
                    CTkMessagebox(master=self.master, title="Validation Error", message="Name and Exe Path are required to enable Autolaunch.", icon="cancel")
                    self.autolaunch_toggle.deselect()
                    return

                # Validate that executable path actually exists
                if not os.path.isfile(exe_path):
                    CTkMessagebox(master=self.master, title="Validation Error", message=f"Cannot enable Autolaunch: Executable path does not exist.\n\n{exe_path}\n\nPlease set a valid executable path first.", icon="cancel")
                    self.autolaunch_toggle.deselect()
                    return

            self.config['processes'][index]['autolaunch'] = new_state
            shared_utils.save_config(self.config)

            # Upload to Firestore immediately for fast sync (in background thread)
            if self.firebase_client:
                def upload_in_background():
                    try:
                        self.firebase_client.upload_config(self._get_config_for_firestore())
                        logging.info("Config uploaded to Firestore immediately after toggle")

                        # Push metrics so web app sees the change immediately
                        metrics = shared_utils.get_system_metrics(skip_gpu=True)
                        self.firebase_client._upload_metrics(metrics)
                        logging.info("Metrics pushed to Firestore after toggle")
                    except Exception as e:
                        logging.error(f"Failed to upload to Firestore: {e}")

                # Run in background thread so GUI stays responsive
                upload_thread = threading.Thread(target=upload_in_background, daemon=True)
                upload_thread.start()

            # Status message if process has been launched
            try:
                pid = shared_utils.fetch_pid_by_id(self.config['processes'][index]['id'])
                shared_utils.update_process_status_in_json(pid, 'INACTIVE' if current_state else 'QUEUED', process_id=self.config['processes'][index]['id'])
            except Exception as e:
                logging.info(e)

    def new_process(self):
        """Create a new process entry immediately with default values"""
        # Generate unique ID
        unique_id = str(uuid.uuid4())

        # Create new process with default values
        new_process = {
            'id': unique_id,
            'name': 'New Process',
            'exe_path': '',
            'file_path': '',
            'cwd': '',
            'priority': 'Normal',
            'visibility': 'Show',
            'time_delay': '0',
            'time_to_init': '10',
            'relaunch_attempts': '3',
            'autolaunch': False
        }

        # Add to config and save
        self.config['processes'].append(new_process)
        shared_utils.save_config(self.config)

        # Upload to Firestore immediately for fast sync (in background thread)
        if self.firebase_client:
            def upload_in_background():
                try:
                    self.firebase_client.upload_config(self._get_config_for_firestore())
                    logging.info("Config uploaded to Firestore immediately after new process")

                    # Push metrics so web app sees the change immediately
                    metrics = shared_utils.get_system_metrics(skip_gpu=True)
                    self.firebase_client._upload_metrics(metrics)
                    logging.info("Metrics pushed to Firestore after new process")
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
                CTkMessagebox(master=self.master, title="Validation Error", message="Relaunch attempts must be an integer. 3 is recommended. After 3 attempts, a system restart will be attempted. Set to 0 for unlimited attempts to relaunch (no system restart).", icon="cancel")
                self.relaunch_attempts_entry.delete(0, tk.END)
                self.relaunch_attempts_entry.insert(0, 3)
                return
            else:
                # For soft saves, just use default value but continue saving
                relaunch_attempts = '3'

        # Check if relaunch attempts is empty and set to default if so
        if not relaunch_attempts:
            relaunch_attempts = 3  # Default value

        # Check if time to init is empty and set to default if so
        if not time_to_init:
            relaunch_attempts = 60  # Default value

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
                        logging.info("Config uploaded to Firestore immediately after process update")

                        # Push metrics so web app sees the change immediately
                        metrics = shared_utils.get_system_metrics(skip_gpu=True)
                        self.firebase_client._upload_metrics(metrics)
                        logging.info("Metrics pushed to Firestore after process update")
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
            autolaunch = True if self.autolaunch_toggle.get() == 'on' else False

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
                'autolaunch': autolaunch
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
        relaunch_attempts = self.relaunch_attempts_entry.get() if self.relaunch_attempts_entry.get() else 3 # Default to 3 if empty
        autolaunch = True if self.autolaunch_toggle.get() == 'on' else False
        
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
            'autolaunch': autolaunch
        }

        self.config['processes'].append(new_process)
        shared_utils.save_config(self.config)
        self.update_process_list()

    # BROWSING FOR FILES

    def browse_exe(self):
        exe_path = filedialog.askopenfilename(initialdir="C:/", title="Select Exe File", filetypes=[("Executable files", "*.exe")])
        self.exe_path_entry.delete(0, tk.END)
        self.exe_path_entry.insert(0, exe_path)
        self.update_selected_process()

    def browse_file(self):
        file_path = filedialog.askopenfilename(initialdir="C:/", title="Select File")
        self.file_path_entry.delete(0, tk.END)
        self.file_path_entry.insert(0, file_path)
        self.update_selected_process()

    def browse_cwd(self):
        cwd = filedialog.askdirectory(initialdir="C:/", title="Select Working Directory")
        self.cwd_entry.delete(0, tk.END)
        self.cwd_entry.insert(0, cwd)
        self.update_selected_process()

    # PROCESS LIST

    def get_os_pid_by_process_id(self, process_list_id, result_file_path):
        app_states = shared_utils.read_json_from_file(result_file_path)

        # Defensive programming: ensure app_states is never None
        if app_states is None:
            app_states = {}

        # Filter the dictionary by the process_list_id and return the highest PID (most recent)
        matching_pids = [pid for pid, info in app_states.items() if info.get('id') == process_list_id]
        last_pid = max(matching_pids, key=int) if matching_pids else None
        return int(last_pid) if last_pid else None

    def kill_process(self):
        if self.selected_process:
            os_pid = self.get_os_pid_by_process_id(self.selected_process, shared_utils.RESULT_FILE_PATH)
            killed = False

            # Get process name for logging
            process_name = None
            for process in self.config.get('processes', []):
                if process.get('id') == self.selected_process:
                    process_name = process.get('name')
                    break

            if os_pid:
                try:
                    # Use graceful_terminate (WM_CLOSE then hard kill) instead of
                    # os.kill(SIGTERM) which doesn't work for Windows GUI processes
                    shared_utils.graceful_terminate(os_pid)
                    killed = True

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
                    CTkMessagebox(master=self.master, title="Error", message=f"Failed to kill the process: {e}", icon="cancel")
            else:
                CTkMessagebox(master=self.master, title="Error", message="No OS process ID found for the selected process.", icon="cancel")

            if killed:
                shared_utils.update_process_status_in_json(os_pid, 'KILLED')
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
        for process in updated_config['processes']:
            status = process['status']
            indicator = self.get_status_indicator(status)
            display_text = f"{indicator} {process['name']}"
            color = shared_utils.STATUS_COLORS.get(status, '#64748b')
            new_items.append((display_text, color))

        if new_items != self.prev_process_list:
            if self.prev_process_list and len(new_items) == len(self.prev_process_list):
                # In-place update: same number of items, just update text/color
                for btn, (text, color) in zip(self.process_list.buttons.values(), new_items):
                    btn.configure(text=text, text_color=color)
            else:
                # Full rebuild: item count changed (process added/removed)
                if self.process_list.size() > 0:
                    self.process_list.delete(0, 'end')
                for text, color in new_items:
                    self.process_list.insert('end', text)
                for btn, (_, color) in zip(self.process_list.buttons.values(), new_items):
                    btn.configure(text_color=color)
            self.prev_process_list = new_items

            # Reselect process list item after rebuild (if not editing an entry)
            if self.selected_index is not None and current_focus == '.' or current_focus is None:
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
                                    logging.info("Config uploaded to Firestore immediately after process removal")

                                    # Then push metrics so web app sees the change immediately
                                    metrics = shared_utils.get_system_metrics(skip_gpu=True)
                                    self.firebase_client._upload_metrics(metrics)
                                    logging.info("Metrics pushed to Firestore after process removal")
                                except Exception as e:
                                    logging.error(f"Failed to upload to Firestore: {e}")

                            # Run in background thread so GUI stays responsive
                            upload_thread = threading.Thread(target=upload_in_background, daemon=True)
                            upload_thread.start()

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
                            logging.info("Config uploaded to Firestore immediately after move up")

                            # Push metrics so web app sees the change immediately
                            metrics = shared_utils.get_system_metrics(skip_gpu=True)
                            self.firebase_client._upload_metrics(metrics)
                            logging.info("Metrics pushed to Firestore after move up")
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
                            logging.info("Config uploaded to Firestore immediately after move down")

                            # Push metrics so web app sees the change immediately
                            metrics = shared_utils.get_system_metrics(skip_gpu=True)
                            self.firebase_client._upload_metrics(metrics)
                            logging.info("Metrics pushed to Firestore after move down")
                        except Exception as e:
                            logging.error(f"Failed to upload to Firestore: {e}")

                    # Run in background thread so GUI stays responsive
                    upload_thread = threading.Thread(target=upload_in_background, daemon=True)
                    upload_thread.start()

                self.update_process_list()
                self.process_list.activate(index+1)
        else:
            CTkMessagebox(master=self.master, title="Error", message=f"You must select a process to move it down in the list.", icon="cancel")

    def on_select(self, process_name):
        # Remove status dot indicator "● " or "○ " from the beginning
        if process_name and len(process_name) >= 2 and process_name[1] == ' ':
            process_name = process_name[2:]
        process_id = shared_utils.fetch_process_id_by_name(process_name, self.config)
        self.selected_process = process_id
        process = shared_utils.fetch_process_by_id(process_id, self.config)
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
        autolaunch = process.get('autolaunch', True)
        if autolaunch:
            self.autolaunch_toggle.select()
        else:
            self.autolaunch_toggle.deselect()

    # FIREBASE STATUS

    def update_firebase_status(self):
        """Update Firebase connection status indicator and site button."""
        import os
        import json

        # Check if Firebase is enabled in config
        firebase_enabled = self.config.get('firebase', {}).get('enabled', False)
        site_id = self.config.get('firebase', {}).get('site_id', '')

        # Update site display label (both left and right panel labels)
        site_display = site_id if site_id else "Unassigned"
        self.site_id_label.configure(text=f"Site: {site_display}")
        self.site_label_left.configure(text=f"Site: {site_display}")  # Keep both in sync

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
            self.firebase_status_label.configure(text="Removed from Site", text_color="#f87171")  # Red
            self.site_button.configure(text="Join Site", state="normal")
        elif firebase_enabled and actually_connected:
            self.firebase_status_label.configure(text="Connected", text_color="#4ade80")  # Green
            self.site_button.configure(text="Leave Site", state="normal")
        elif firebase_enabled and service_status_valid and not service_connected:
            # Service is running but not connected (internet down, reconnecting, etc.)
            self.firebase_status_label.configure(text="Disconnected", text_color="#f87171")  # Red
            self.site_button.configure(text="Leave Site", state="normal")
        elif firebase_enabled and not tokens_valid:
            self.firebase_status_label.configure(text="Authentication Required", text_color="#fbbf24")  # Yellow/Warning
            self.site_button.configure(text="Join Site", state="normal")
        else:
            self.firebase_status_label.configure(text="Disabled", text_color="#9ca3af")  # Gray
            self.site_button.configure(text="Join Site", state="normal")

    def on_site_button_click(self):
        """Route to appropriate handler based on current button state."""
        button_text = self.site_button.cget("text")
        if button_text == "Leave Site":
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
                   "To re-join a site, you will need to run the Owlette installer again.",
            icon="warning",
            option_1="Cancel",
            option_2="Leave Site",
            width=550
        )

        if response.get() == "Leave Site":
            # Update status immediately to show we're working (before GUI freezes)
            self.firebase_status_label.configure(text="Disabling...", text_color="#fbbf24")  # Yellow
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
                # NSSM is at C:\Owlette\tools\nssm.exe (three directories up from this file)
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
                        machine_ref = self.firebase_client.db.collection('sites').document(self.site_id)\
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
                    message="This machine has been removed from the site and is no longer monitored.\n\nThe Owlette service has been restarted.",
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
                   "1. Log in to your Owlette account\n"
                   "2. Select or create a site\n"
                   "3. Authorize this machine\n\n"
                   "The service will restart after authentication completes.",
            icon=None,
            option_1="Cancel",
            option_2="Join Site",
            width=550
        )

        if response.get() != "Join Site":
            return

        # Update status immediately to show we're connecting (before any blocking operations)
        self.firebase_status_label.configure(text="Connecting...", text_color="#fbbf24")  # Yellow
        self.master.update()  # Force GUI update before blocking operation

        # Get setup URL based on environment setting
        setup_url = shared_utils.get_setup_url()

        # Show loading dialog (not topmost so browser is accessible)
        loading_dialog = CTkMessagebox(
            master=self.master,
            title="Joining Site...",
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
                               f"The service is now connecting to Firebase. This may take awhile.\n\n"
                               f"The status will update automatically once connected.",
                        icon=None,
                        width=600
                    ))
                else:
                    logging.error(f"Failed to join site: {message}")
                    # Show error message
                    self.master.after(0, lambda: CTkMessagebox(
                        master=self.master,
                        title="Failed to Join Site",
                        message=f"Could not complete authentication:\n\n{message}\n\nPlease try again or check the logs for details.",
                        icon=None,
                        width=600
                    ))

            except Exception as e:
                logging.error(f"Error in OAuth flow: {e}")
                self.master.after(0, loading_dialog.destroy)
                self.master.after(0, lambda: CTkMessagebox(
                    master=self.master,
                    title="Error",
                    message=f"An unexpected error occurred:\n\n{str(e)}",
                    icon=None,
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
        """Restart the Owlette service."""
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
                message="The Owlette service has been restarted successfully.",
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
    root = ctk.CTk()
    app = OwletteConfigApp(root)
    root.mainloop()