"""
User-session command executor for Owlette.

This script is launched by the service (via CreateProcessAsUser) in the
interactive user's desktop session. It reads a job file, executes the
requested command (Python / cmd / PowerShell), and writes the result.

Usage:
    pythonw.exe session_exec.py <job_file_path>

Job file (JSON):
    {
        "type": "python" | "cmd" | "powershell",
        "code": "...",
        "timeout": 30,
        "outputDir": "C:/ProgramData/Owlette/ipc/results/<requestId>"
    }

Result file (<outputDir>/result.json):
    {
        "stdout": "...",
        "stderr": "...",
        "exitCode": 0,
        "error": null,
        "durationMs": 1234,
        "files": ["screenshot.jpg"]
    }

Any files the code writes into outputDir are reported in the "files" list.
"""

import json
import os
import subprocess
import sys
import time
import traceback


def run_python(code, output_dir, timeout):
    """Execute Python code in-process. Code can write files to output_dir."""
    stdout_lines = []
    stderr_lines = []

    # Make output_dir available to the code
    globals_dict = {
        '__builtins__': __builtins__,
        'output_dir': output_dir,
        'print': lambda *args, **kwargs: stdout_lines.append(
            ' '.join(str(a) for a in args)
        ),
    }

    try:
        exec(code, globals_dict)
        return {
            'stdout': '\n'.join(stdout_lines),
            'stderr': '',
            'exitCode': 0,
            'error': None,
        }
    except Exception as e:
        return {
            'stdout': '\n'.join(stdout_lines),
            'stderr': traceback.format_exc(),
            'exitCode': 1,
            'error': str(e),
        }


def run_subprocess(cmd_list, timeout):
    """Execute a command via subprocess, capture output."""
    try:
        result = subprocess.run(
            cmd_list,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return {
            'stdout': result.stdout[:50000],
            'stderr': result.stderr[:10000],
            'exitCode': result.returncode,
            'error': None,
        }
    except subprocess.TimeoutExpired:
        return {
            'stdout': '',
            'stderr': '',
            'exitCode': -1,
            'error': f'Command timed out after {timeout}s',
        }
    except Exception as e:
        return {
            'stdout': '',
            'stderr': traceback.format_exc(),
            'exitCode': -1,
            'error': str(e),
        }


def main():
    if len(sys.argv) < 2:
        print('Usage: session_exec.py <job_file_path>', file=sys.stderr)
        sys.exit(1)

    job_path = sys.argv[1]

    try:
        with open(job_path, 'r') as f:
            job = json.load(f)
    except Exception as e:
        print(f'Failed to read job file: {e}', file=sys.stderr)
        sys.exit(1)

    job_type = job.get('type', 'cmd')
    code = job.get('code', '')
    timeout = min(job.get('timeout', 30), 120)
    output_dir = job.get('outputDir', os.path.dirname(job_path))

    os.makedirs(output_dir, exist_ok=True)

    start_time = time.time()

    # Dispatch based on type
    if job_type == 'python':
        result = run_python(code, output_dir, timeout)
    elif job_type == 'powershell':
        result = run_subprocess(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command', code],
            timeout,
        )
    elif job_type == 'cmd':
        result = run_subprocess(['cmd', '/c', code], timeout)
    else:
        result = {
            'stdout': '',
            'stderr': '',
            'exitCode': -1,
            'error': f'Unknown job type: {job_type}',
        }

    duration_ms = int((time.time() - start_time) * 1000)
    result['durationMs'] = duration_ms

    # List any files the code created in output_dir (excluding result.json itself)
    try:
        result['files'] = [
            f for f in os.listdir(output_dir)
            if f != 'result.json' and os.path.isfile(os.path.join(output_dir, f))
        ]
    except Exception:
        result['files'] = []

    # Write result
    result_path = os.path.join(output_dir, 'result.json')
    with open(result_path, 'w') as f:
        json.dump(result, f)


if __name__ == '__main__':
    main()
