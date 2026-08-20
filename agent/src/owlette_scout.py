import ctypes
import json
import os
import sys
import time
import win32gui
import win32process
import shared_utils

def is_app_responsive(pid):
    hung_windows = []
    def enum_windows_callback(hwnd, extra):
        _, curr_pid = win32process.GetWindowThreadProcessId(hwnd)
        if curr_pid == pid:
            if ctypes.windll.user32.IsHungAppWindow(hwnd):
                hung_windows.append(hwnd)
    win32gui.EnumWindows(enum_windows_callback, None)
    
    if hung_windows:
        return False
    return True

pid = int(sys.argv[1])
current_time = int(time.time())
result = True

results = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)

if results is None:
    results = {}

process_info = results.get(str(pid), {})
timestamp = process_info.get('timestamp', 0)
current_time = int(time.time())
time_since_launch = current_time - timestamp

if time_since_launch < 60:
    # Still initializing — too early to judge responsiveness.
    result = True
else:
    result = is_app_responsive(pid)

if str(pid) not in results:
    results[str(pid)] = {}

results[str(pid)]['responsive'] = result

# hung_since drives confirmation-based killing: a hang must persist to count.
if not result:
    if 'hung_since' not in results[str(pid)] or results[str(pid)].get('responsive_prev', True):
        results[str(pid)]['hung_since'] = current_time
else:
    if 'hung_since' in results[str(pid)]:
        del results[str(pid)]['hung_since']

# Track previous responsive state for edge detection
results[str(pid)]['responsive_prev'] = result

shared_utils.write_json_to_file(results, shared_utils.RESULT_FILE_PATH)