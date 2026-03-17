"""Lightweight process launcher helper for Owlette.

Launched by the Owlette service via CreateProcessAsUser into the user's
interactive session.

Flow:
  1. Reads launch parameters from a JSON file written by the service
  2. Creates a one-shot Task Scheduler task that runs a temp VBScript via
     wscript.exe to launch the target through the Windows Shell
     - wscript.exe is a GUI host — no console window flash (unlike cmd.exe)
     - WScript.Shell.Run uses ShellExecuteEx which fully initializes the
       desktop/GPU context for apps like TouchDesigner
     - Task Scheduler with TASK_LOGON_INTERACTIVE_TOKEN ensures the task
       runs in the user's interactive session
     - The COM call to Task Scheduler MUST come from the user's session
       (Session 0 COM calls produce background processes)
  3. Detects the target PID via psutil exe path scanning
  4. Handles single-instance apps that reuse an existing process
  5. Writes the target's PID to a file for the service to read
  6. Cleans up the scheduled task and temp VBS file, then exits
"""
import sys
import os
import json
import time
import tempfile


def find_pids_by_exe(exe_path, match_by_name=False):
    """Find all PIDs matching an executable.

    When match_by_name is True, matches by filename only (e.g. 'TouchDesigner.exe')
    instead of the full path. This is needed when using file association, which may
    launch a different version/path than the user configured.
    """
    pids = set()
    try:
        import psutil
        if match_by_name:
            target = os.path.basename(exe_path).lower()
            for proc in psutil.process_iter(['pid', 'exe']):
                try:
                    if proc.info['exe'] and os.path.basename(proc.info['exe']).lower() == target:
                        pids.add(proc.info['pid'])
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
        else:
            exe_lower = exe_path.lower()
            for proc in psutil.process_iter(['pid', 'exe']):
                try:
                    if proc.info['exe'] and proc.info['exe'].lower() == exe_lower:
                        pids.add(proc.info['pid'])
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
    except Exception:
        pass
    return pids


def write_result(pid_file, pid=None, error=None, adopted=False):
    """Write launch result to PID file as JSON."""
    result = {}
    if error:
        result['error'] = str(error)
    else:
        result['pid'] = pid
        if adopted:
            result['adopted'] = True
    with open(pid_file, 'w') as f:
        json.dump(result, f)


def main():
    if len(sys.argv) < 2:
        sys.exit(1)

    args_file = sys.argv[1]

    try:
        with open(args_file, 'r') as f:
            args = json.load(f)
    except Exception:
        sys.exit(1)

    exe_path = args['exe_path']
    file_path = args.get('file_path', '')
    cwd = args.get('cwd')
    visibility = args.get('visibility', 'Normal')
    pid_file = args['pid_file']

    # Backward compat
    if args.get('hidden', False) and visibility == 'Normal':
        visibility = 'Hidden'

    # When using file association (file_path set), match PIDs by exe name only,
    # since file association may launch a different version/path than configured.
    use_name_match = bool(file_path) and visibility != 'Hidden'

    task_name = None
    vbs_path = None
    try:
        # Snapshot existing instances before launch (for single-instance detection)
        existing_pids = find_pids_by_exe(exe_path, match_by_name=use_name_match)

        # Map visibility to WScript.Shell.Run window style constants
        # 1 = SW_SHOWNORMAL, 2 = SW_SHOWMINIMIZED, 3 = SW_SHOWMAXIMIZED, 0 = SW_HIDE
        wsh_style_map = {
            'Normal': 1, 'Minimized': 2, 'Maximized': 3, 'Hidden': 0,
        }
        wsh_style = wsh_style_map.get(visibility, 1)

        # Build the launch target path.
        # When file_path is set, pass the FILE (not the exe). This uses
        # Windows file association (ShellExecuteEx) which fully initializes the
        # desktop/GPU context. Passing the exe directly uses CreateProcess which
        # doesn't — GPU apps like TouchDesigner run as invisible background processes.
        launch_target = file_path if file_path else exe_path

        if visibility == 'Hidden':
            # Hidden processes don't need shell context — launch exe directly
            # via Task Scheduler (no VBS needed)
            use_vbs = False
        else:
            # Create a temporary VBScript that launches via WScript.Shell.Run.
            # wscript.exe is a GUI host — no console window flash.
            # WScript.Shell.Run uses ShellExecuteEx internally, giving full
            # desktop/GPU context for the launched app.
            use_vbs = True
            vbs_fd, vbs_path = tempfile.mkstemp(suffix='.vbs', prefix='owlette_launch_')
            # Escape backslashes and quotes for VBS string literal
            vbs_target = launch_target.replace('"', '""')
            vbs_script = f'CreateObject("WScript.Shell").Run """{vbs_target}""", {wsh_style}, False\n'
            os.write(vbs_fd, vbs_script.encode('utf-8'))
            os.close(vbs_fd)

        # Create and run a one-shot Task Scheduler task via COM API.
        # This COM call is made FROM the user's session (this helper runs in
        # the user's session via CreateProcessAsUser). This is critical —
        # COM calls from Session 0 (SYSTEM) produce tasks that lack full
        # interactive desktop context.
        import win32com.client

        TASK_LOGON_INTERACTIVE_TOKEN = 3
        TASK_CREATE_OR_UPDATE = 6
        TASK_ACTION_EXEC = 0

        scheduler = win32com.client.Dispatch('Schedule.Service')
        scheduler.Connect()
        root_folder = scheduler.GetFolder("\\")

        task_def = scheduler.NewTask(0)
        task_def.Settings.Enabled = True
        task_def.Settings.AllowDemandStart = True
        task_def.Settings.StopIfGoingOnBatteries = False
        task_def.Settings.DisallowStartIfOnBatteries = False
        task_def.Settings.ExecutionTimeLimit = 'PT1M'

        action = task_def.Actions.Create(TASK_ACTION_EXEC)
        if use_vbs:
            action.Path = 'wscript.exe'
            action.Arguments = f'"{vbs_path}"'
        else:
            # Hidden: launch exe directly via Task Scheduler
            action.Path = exe_path
            action.Arguments = f'"{file_path}"' if file_path else ''
        if cwd:
            action.WorkingDirectory = cwd

        # Get current username for task registration
        task_name = f"Owlette_Launch_{os.getpid()}"
        username = os.environ.get('USERNAME', os.environ.get('USER', ''))
        domain = os.environ.get('USERDOMAIN', '')
        full_username = f"{domain}\\{username}" if domain else username

        root_folder.RegisterTaskDefinition(
            task_name, task_def, TASK_CREATE_OR_UPDATE,
            full_username, None, TASK_LOGON_INTERACTIVE_TOKEN
        )

        task = root_folder.GetTask(task_name)
        task.Run(None)

        # Poll for the new process PID (up to 10 seconds)
        pid = None
        for _ in range(20):
            time.sleep(0.5)
            current_pids = find_pids_by_exe(exe_path, match_by_name=use_name_match)
            new_pids = current_pids - existing_pids
            if new_pids:
                pid = new_pids.pop()
                break

        if pid:
            write_result(pid_file, pid=pid)
        else:
            # No new PID — check for single-instance app (adopted existing)
            current_pids = find_pids_by_exe(exe_path, match_by_name=use_name_match)
            if current_pids:
                pid = current_pids.pop()
                write_result(pid_file, pid=pid, adopted=True)
            else:
                write_result(pid_file, error="Process not found after launch")
                sys.exit(1)

    except Exception as e:
        try:
            write_result(pid_file, error=str(e))
        except Exception:
            pass
        sys.exit(1)
    finally:
        # Clean up the scheduled task
        if task_name:
            try:
                scheduler = win32com.client.Dispatch('Schedule.Service')
                scheduler.Connect()
                scheduler.GetFolder("\\").DeleteTask(task_name, 0)
            except Exception:
                pass
        # Clean up the temp VBS file
        if vbs_path:
            try:
                os.unlink(vbs_path)
            except Exception:
                pass


if __name__ == '__main__':
    main()
