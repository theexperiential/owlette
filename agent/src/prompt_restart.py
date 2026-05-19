import customtkinter as ctk
import os
import shared_utils

class PromptRestart:
    FRAME_COLOR = '#28292b'
    BUTTON_COLOR = '#374448'
    BUTTON_HOVER_COLOR = '#27424a'
    WINDOW_WIDTH = 400
    WINDOW_HEIGHT = 200

    def __init__(self, master):
        self.master = master
        self.master.title("Process repeatedly failing!")
        shared_utils.center_window(master, self.WINDOW_WIDTH, self.WINDOW_HEIGHT)
        self.master.lift()
        self.master.focus_force()
        

        self.paused = False
        self.time_left = 119

        self.setup_ui()

    def setup_ui(self):
        self.main_frame = ctk.CTkFrame(master=self.master, fg_color=self.FRAME_COLOR)
        self.main_frame.pack(fill='both', expand=True)

        self.label = ctk.CTkLabel(self.main_frame, text="The system will restart automatically in 2:00.", fg_color=self.FRAME_COLOR)
        self.label.pack(padx=10, pady=(20, 10))

        self.restart_button = ctk.CTkButton(self.main_frame, text="Restart Now", command=self.restart_now, fg_color=self.BUTTON_COLOR, hover_color=self.BUTTON_HOVER_COLOR)
        self.restart_button.pack(pady=10)

        self.pause_switch = ctk.CTkSwitch(self.main_frame, text="Pause", command=self.toggle_pause, fg_color=self.BUTTON_COLOR, onvalue="on", offvalue="off")
        self.pause_switch.pack(pady=10)

        self.cancel_button = ctk.CTkButton(self.main_frame, text="Cancel", command=self.cancel, fg_color=self.BUTTON_COLOR, hover_color=self.BUTTON_HOVER_COLOR)
        self.cancel_button.pack(pady=10)

        self.master.after(1000, self.countdown)

    def restart_now(self):
        print("Restarting")
        # Mark this reboot as Owlette-initiated so the next startup classifier
        # treats it as planned and stays silent. The dialog only appears after
        # Owlette spawned us in response to a process exceeding max relaunch
        # attempts, so any reboot from this dialog is part of the Owlette flow.
        try:
            import session_state
            session_state.set_intent("owlette_reboot")
        except Exception as e:
            print(f"session_state.set_intent failed in prompt_restart: {e}")
        os.system('shutdown /r /t 1')
        self.master.quit()

    def cancel(self):
        print("Cancel")
        self.master.quit()

    def toggle_pause(self):
        self.paused = False if self.pause_switch.get() == 'off' else True
        if not self.paused:
            self.countdown()

    def countdown(self):
        if not self.paused:
            if self.time_left > 0:
                mins, secs = divmod(self.time_left, 60)
                time_str = f"{mins}:{secs}"
                self.label.configure(text=f"The system will restart automatically in {time_str}.")
                self.time_left -= 1
                self.master.after(1000, self.countdown)
            else:
                self.restart_now()

if __name__ == "__main__":
    root = ctk.CTk()
    app = PromptRestart(root)
    root.mainloop()
