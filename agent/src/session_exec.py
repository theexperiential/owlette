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

import builtins as _builtins
import json
import logging
import os
import subprocess
import sys
import time
import traceback

# Safe subset of builtins for run_python sandboxing.
# Excludes: eval, exec, compile, globals, locals, breakpoint, exit, quit, input
# Includes: open (for writing to output_dir), getattr/setattr/delattr (introspection),
#           __import__ (needed for import statements — restricted to safe modules below)
_SAFE_BUILTINS = {
    name: getattr(_builtins, name) for name in [
        'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'bytearray', 'bytes',
        'callable', 'chr', 'classmethod', 'complex', 'dict', 'dir', 'divmod',
        'enumerate', 'filter', 'float', 'format', 'frozenset',
        'getattr', 'setattr', 'delattr', 'hasattr',
        'hash', 'hex', 'id', 'int', 'isinstance', 'issubclass', 'iter',
        'len', 'list', 'map', 'max', 'min', 'next', 'object', 'oct', 'open', 'ord',
        'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round',
        'set', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super',
        'tuple', 'type', 'vars', 'zip',
        'True', 'False', 'None',
        'ArithmeticError', 'AssertionError', 'AttributeError', 'BaseException',
        'EOFError', 'Exception', 'FileNotFoundError', 'IndexError', 'KeyError',
        'KeyboardInterrupt', 'NameError', 'NotImplementedError', 'OSError',
        'OverflowError', 'RuntimeError', 'StopIteration', 'SystemExit',
        'TypeError', 'ValueError', 'ZeroDivisionError',
    ] if hasattr(_builtins, name)
}

# Modules that run_python scripts are allowed to import.
# Dangerous modules (os, subprocess, shutil, ctypes, socket) are blocked.
_SAFE_MODULES = frozenset({
    'math', 'json', 're', 'datetime', 'time', 'random', 'collections',
    'itertools', 'functools', 'operator', 'string', 'textwrap',
    'decimal', 'fractions', 'statistics', 'copy', 'pprint',
    'base64', 'hashlib', 'hmac', 'struct', 'io', 'csv',
    'pathlib', 'typing', 'dataclasses', 'enum', 'abc',
})


def _restricted_import(name, *args, **kwargs):
    """Import gate that only allows safe standard library modules."""
    top_level = name.split('.')[0]
    if top_level not in _SAFE_MODULES:
        raise ImportError(
            f"Module '{name}' is not allowed in run_python. "
            f"Allowed: {', '.join(sorted(_SAFE_MODULES))}. "
            f"For OS access, use execute_script or run_command instead."
        )
    return __import__(name, *args, **kwargs)


def run_python(code, output_dir, timeout, trusted=False):
    """Execute Python code in-process.

    When trusted=False (default, used by the run_python MCP tool): sandboxed
    builtins, imports restricted to _SAFE_MODULES (math, json, re, io, base64,
    etc.), no eval/exec/compile, no os/subprocess/shutil/ctypes/socket.

    When trusted=True (internal first-party callers like screenshot capture):
    full builtins and unrestricted imports. The LLM cannot set this flag —
    it's controlled by the service-side caller of execute_in_user_session.
    """
    stdout_lines = []

    if trusted:
        globals_dict = {
            '__builtins__': _builtins.__dict__,
            'output_dir': output_dir,
            'print': lambda *args, **kwargs: stdout_lines.append(
                ' '.join(str(a) for a in args)
            ),
        }
    else:
        globals_dict = {
            '__builtins__': {**_SAFE_BUILTINS, '__import__': _restricted_import},
            'output_dir': output_dir,
            'print': lambda *args, **kwargs: stdout_lines.append(
                ' '.join(str(a) for a in args)
            ),
        }

    logging.info(f"[MCP-AUDIT] run_python called. Code length: {len(code)} chars, trusted={trusted}")

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
    trusted = bool(job.get('trusted', False))

    os.makedirs(output_dir, exist_ok=True)

    start_time = time.time()

    # Dispatch based on type
    if job_type == 'python':
        result = run_python(code, output_dir, timeout, trusted=trusted)
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
