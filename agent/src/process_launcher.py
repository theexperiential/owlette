"""Lightweight process launcher helper for Owlette.

Launched by the Owlette service via CreateProcessAsUser into the user's
interactive session.

Flow:
  1. Reads launch parameters from a JSON file written by the service
  2. Launches the target process directly via ShellExecuteEx (ctypes) which:
     - Fully initializes the desktop/GPU context for apps like TouchDesigner
     - Returns the process handle so we get the PID immediately — no scanning
     - Supports file association (passing a .toe file launches TouchDesigner)
     - This helper already runs in the user's session (via CreateProcessAsUser)
       so the launched process inherits full interactive desktop context
  3. For hidden processes, uses subprocess.Popen (no shell context needed)
  4. Writes the target's PID to a file for the service to read
"""
import sys
import os
import json
import ctypes
import ctypes.wintypes
import subprocess


def find_pids_by_exe(exe_path, match_by_name=False):
    """Find all PIDs matching an executable.

    When match_by_name is True, matches by filename only (e.g. 'TouchDesigner.exe')
    instead of the full path. This is needed when using file association, which may
    launch a different version/path than the user configured.

    When match_by_name is False, matches by full path first, then falls back to
    basename matching (handles short paths, case differences, etc.).
    """
    pids = set()
    try:
        import psutil
        exe_lower = exe_path.replace('/', '\\').lower()
        exe_basename = os.path.basename(exe_lower)
        for proc in psutil.process_iter(['pid', 'exe']):
            try:
                proc_exe = proc.info['exe']
                if not proc_exe:
                    continue
                proc_exe_lower = proc_exe.lower()
                if match_by_name:
                    if os.path.basename(proc_exe_lower) == exe_basename:
                        pids.add(proc.info['pid'])
                else:
                    if proc_exe_lower == exe_lower or os.path.basename(proc_exe_lower) == exe_basename:
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


def shell_execute_ex(target, parameters=None, cwd=None, visibility='Normal'):
    """Launch a process via ShellExecuteEx and return its PID.

    Uses SEE_MASK_NOCLOSEPROCESS to get the process handle back,
    then extracts the PID from it. This gives us the PID immediately
    without any scanning.

    Args:
        target: The file or executable to open (lpFile).
        parameters: Command-line arguments passed to the target (lpParameters).
        cwd: Working directory for the launched process.
        visibility: Window visibility ('Normal', 'Minimized', 'Maximized', 'Hidden').
    """
    # ShellExecuteEx structs and constants
    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    SEE_MASK_FLAG_NO_UI = 0x00000400

    sw_map = {'Normal': 1, 'Minimized': 2, 'Maximized': 3, 'Hidden': 0}
    nShow = sw_map.get(visibility, 1)

    class SHELLEXECUTEINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.wintypes.DWORD),
            ("fMask", ctypes.c_ulong),
            ("hwnd", ctypes.wintypes.HANDLE),
            ("lpVerb", ctypes.c_wchar_p),
            ("lpFile", ctypes.c_wchar_p),
            ("lpParameters", ctypes.c_wchar_p),
            ("lpDirectory", ctypes.c_wchar_p),
            ("nShow", ctypes.c_int),
            ("hInstApp", ctypes.wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", ctypes.c_wchar_p),
            ("hkeyClass", ctypes.wintypes.HKEY),
            ("dwHotKey", ctypes.wintypes.DWORD),
            ("hIcon", ctypes.wintypes.HANDLE),
            ("hProcess", ctypes.wintypes.HANDLE),
        ]

    sei = SHELLEXECUTEINFO()
    sei.cbSize = ctypes.sizeof(SHELLEXECUTEINFO)
    sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI
    sei.lpVerb = "open"
    sei.lpFile = target
    sei.lpParameters = parameters
    sei.lpDirectory = cwd
    sei.nShow = nShow
    sei.hProcess = None

    success = ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(sei))
    if not success:
        error_code = ctypes.GetLastError()
        raise OSError(f"ShellExecuteEx failed with error code {error_code}")

    if sei.hProcess:
        pid = ctypes.windll.kernel32.GetProcessId(sei.hProcess)
        ctypes.windll.kernel32.CloseHandle(sei.hProcess)
        if pid:
            return pid

    return None


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

    try:
        # Determine launch target and parameters for ShellExecuteEx.
        #
        # ShellExecuteEx(lpFile, lpParameters) maps to how Windows opens things:
        #   lpFile = the thing to open (exe or document for file association)
        #   lpParameters = arguments passed to the application
        #
        # When file_path is a real file (e.g. project.toe), we use file association:
        #   lpFile = "project.toe", lpParameters = None
        #   Windows resolves the associated app (TouchDesigner) with full GPU context.
        #
        # When file_path contains CLI flags (e.g. "--headless --port 8080"):
        #   lpFile = exe_path, lpParameters = file_path
        #   The exe runs directly with the flags as arguments.
        #
        # When file_path is empty:
        #   lpFile = exe_path, lpParameters = None

        launch_target = exe_path
        parameters = None

        if file_path:
            # Check if file_path is a document that should use file association.
            # Only use file association when the document type differs from the exe
            # (e.g. .toe file with TouchDesigner.exe). When the exe can directly
            # run the file_path (e.g. pythonw.exe running a .py script), pass it
            # as a parameter instead — otherwise Windows opens the file with
            # whatever app is associated (e.g. VS Code for .py files).
            if os.path.isfile(file_path):
                file_ext = os.path.splitext(file_path)[1].lower()
                exe_ext = os.path.splitext(exe_path)[1].lower()
                exe_name = os.path.basename(exe_path).lower()
                # Interpreters/runtimes that take scripts as arguments
                interpreter_names = {'python.exe', 'pythonw.exe', 'python3.exe',
                                     'node.exe', 'ruby.exe', 'perl.exe', 'java.exe',
                                     'powershell.exe', 'pwsh.exe', 'cmd.exe', 'wscript.exe', 'cscript.exe'}
                if exe_name in interpreter_names:
                    # Pass the script as a parameter, don't use file association
                    parameters = f'"{file_path}"'
                else:
                    # Real document — use file association (lpFile = document)
                    launch_target = file_path
            else:
                # Not a file on disk — treat as CLI arguments
                parameters = file_path

        if visibility == 'Hidden':
            # Hidden processes don't need shell context — use subprocess directly
            cmd = [exe_path]
            if file_path:
                if os.path.isfile(file_path):
                    cmd.append(file_path)
                else:
                    # Split CLI args string into list for subprocess
                    import shlex
                    cmd.extend(shlex.split(file_path, posix=False))
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags = subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0  # SW_HIDE
            proc = subprocess.Popen(
                cmd,
                cwd=cwd or None,
                startupinfo=startupinfo,
                creationflags=subprocess.DETACHED_PROCESS
            )
            pid = proc.pid
        else:
            # Use ShellExecuteEx directly — this helper already runs in the
            # user's interactive session (via CreateProcessAsUser), so the
            # launched process gets full desktop/GPU context.
            pid = shell_execute_ex(launch_target, parameters=parameters, cwd=cwd, visibility=visibility)

        if pid:
            # For file association launches, the PID from ShellExecuteEx might be
            # a launcher/stub that spawns the real app. Check if this is a
            # single-instance app that adopted an existing process.
            use_file_assoc = (launch_target != exe_path) and visibility != 'Hidden'
            if use_file_assoc:
                # Give the file association a moment to resolve
                import time
                time.sleep(1)
                # Check if the real app is running (might be different PID)
                current_pids = find_pids_by_exe(exe_path, match_by_name=True)
                if current_pids:
                    real_pid = current_pids.pop()
                    if real_pid != pid:
                        pid = real_pid
                        write_result(pid_file, pid=pid, adopted=True)
                        return
            write_result(pid_file, pid=pid)
        else:
            write_result(pid_file, error="ShellExecuteEx returned no process handle")
            sys.exit(1)

    except Exception as e:
        try:
            write_result(pid_file, error=str(e))
        except Exception:
            pass
        sys.exit(1)


if __name__ == '__main__':
    main()
