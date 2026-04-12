"""
MCP Tool implementations for Owlette Agent.

These tools are invoked via Firestore commands (type: 'mcp_tool_call')
from the web dashboard's chat interface. Each function returns a structured
dict that gets sent back as the tool result.

No new dependencies — uses existing psutil, subprocess, platform, socket, etc.
"""

import hashlib
import logging
import os
import platform
import re
import shlex
import socket
import subprocess
import time
import json
from datetime import datetime

import psutil

import shared_utils

logger = logging.getLogger(__name__)

# Default allow-list for run_command / run_powershell
DEFAULT_ALLOWED_COMMANDS = [
    'ipconfig', 'systeminfo', 'hostname', 'whoami', 'tasklist',
    'netstat', 'ping', 'tracert', 'nslookup', 'dir', 'type',
    'echo', 'set', 'ver', 'wmic', 'sc', 'net', 'reg', 'nvidia-smi', 'dxdiag',
    'Get-Process', 'Get-Service', 'Get-EventLog', 'Get-WinEvent',
    'Get-NetAdapter', 'Get-NetIPAddress', 'Get-Disk', 'Get-Volume',
    'Get-ComputerInfo', 'Get-HotFix', 'Test-Connection',
    'Get-ChildItem', 'Get-Content', 'Get-ItemProperty',
]

# Maximum output size returned from commands (characters)
MAX_OUTPUT_SIZE = 50000

# Subprocess timeout (seconds)
SUBPROCESS_TIMEOUT = 25


def execute_tool(tool_name, tool_params, config=None):
    """
    Dispatch a tool call to the appropriate handler.

    Args:
        tool_name: Name of the tool to execute
        tool_params: Dict of parameters for the tool
        config: Optional agent config dict (avoids re-reading from disk)

    Returns:
        Dict with tool result or error
    """
    handlers = {
        'get_system_info': _get_system_info,
        'get_process_list': _get_process_list,
        'get_running_processes': _get_running_processes,
        'get_gpu_processes': _get_gpu_processes,
        'get_network_info': _get_network_info,
        'get_disk_usage': _get_disk_usage,
        'get_event_logs': _get_event_logs,
        'get_service_status': _get_service_status,
        'get_agent_config': _get_agent_config,
        'get_agent_logs': _get_agent_logs,
        'get_agent_health': _get_agent_health,
        'run_command': _run_command,
        'run_powershell': _run_powershell,
        'execute_script': _execute_script,
        'read_file': _read_file,
        'write_file': _write_file,
        'list_directory': _list_directory,
    }

    handler = handlers.get(tool_name)
    if not handler:
        return {'error': f'Unknown tool: {tool_name}'}

    try:
        return handler(tool_params, config)
    except Exception as e:
        logger.error(f"Tool '{tool_name}' failed: {e}")
        return {'error': str(e)}


# ─── Tier 1: Read-Only Tools ────────────────────────────────────────────────


def _get_system_info(params, config):
    """Get comprehensive system information."""
    boot_time = psutil.boot_time()
    uptime_seconds = int(time.time() - boot_time)
    uptime_hours = uptime_seconds // 3600
    uptime_minutes = (uptime_seconds % 3600) // 60

    metrics = shared_utils.get_system_metrics()

    # Get NVIDIA driver version via pynvml (already a dependency for GPU temps)
    gpu_driver_version = 'N/A'
    try:
        from pynvml import nvmlInit, nvmlSystemGetDriverVersion, nvmlShutdown
        nvmlInit()
        gpu_driver_version = nvmlSystemGetDriverVersion()
        nvmlShutdown()
    except Exception:
        pass

    # platform.release() returns "10" on Windows 11 (NT 10.0 build >= 22000)
    os_release = platform.release()
    if platform.system() == 'Windows' and os_release == '10':
        build = platform.version().split('.')[-1] if platform.version() else '0'
        if build.isdigit() and int(build) >= 22000:
            os_release = '11'

    return {
        'hostname': socket.gethostname(),
        'os': f"{platform.system()} {os_release}",
        'os_version': platform.version(),
        'architecture': platform.machine(),
        'cpu_model': metrics.get('cpu', {}).get('model', 'Unknown'),
        'cpu_percent': metrics.get('cpu', {}).get('percent', 0),
        'cpu_cores': psutil.cpu_count(logical=False),
        'cpu_threads': psutil.cpu_count(logical=True),
        'memory_used_gb': metrics.get('memory', {}).get('used_gb', 0),
        'memory_total_gb': metrics.get('memory', {}).get('total_gb', 0),
        'memory_percent': metrics.get('memory', {}).get('percent', 0),
        'disk_used_gb': metrics.get('disk', {}).get('used_gb', 0),
        'disk_total_gb': metrics.get('disk', {}).get('total_gb', 0),
        'disk_percent': metrics.get('disk', {}).get('percent', 0),
        'gpu_model': metrics.get('gpu', {}).get('name', 'N/A'),
        'gpu_driver_version': gpu_driver_version,
        'gpu_usage_percent': metrics.get('gpu', {}).get('usage_percent', 0),
        'gpu_vram_used_gb': metrics.get('gpu', {}).get('vram_used_gb', 0),
        'gpu_vram_total_gb': metrics.get('gpu', {}).get('vram_total_gb', 0),
        'uptime': f"{uptime_hours}h {uptime_minutes}m",
        'uptime_seconds': uptime_seconds,
        'agent_version': shared_utils.get_app_version(),
        'python_version': platform.python_version(),
    }


def _get_process_list(params, config):
    """Get all Owlette-configured processes with their current status."""
    if not config:
        config = shared_utils.read_config()

    processes = config.get('processes', [])
    runtime_state = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)

    result = []
    for proc in processes:
        proc_name = proc.get('name', 'Unknown')
        proc_id = proc.get('id', '')
        autolaunch = proc.get('autolaunch', False)
        launch_mode = proc.get('launch_mode', 'always' if autolaunch else 'off')
        schedules = proc.get('schedules', None)

        # Check runtime state (keyed by PID, matched by process id)
        state_info = {}
        if runtime_state:
            for key, val in runtime_state.items():
                if isinstance(val, dict) and val.get('id') == proc_id:
                    state_info = val
                    state_info['_pid'] = key
                    break

        # PID is the dict key in app_states.json, stored as _pid during lookup
        pid_str = state_info.get('_pid')
        pid = int(pid_str) if pid_str else None
        is_running = False
        if pid:
            try:
                p = psutil.Process(pid)
                is_running = p.is_running() and p.status() != psutil.STATUS_ZOMBIE
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                is_running = False

        result.append({
            'name': proc_name,
            'id': proc_id,
            'exe_path': proc.get('exe_path', proc.get('path', '')),
            'file_path': proc.get('file_path', ''),
            'cwd': proc.get('cwd', ''),
            'autolaunch': autolaunch,
            'launch_mode': launch_mode,
            'schedules': schedules,
            'running': is_running,
            'pid': pid if is_running else None,
            'status': state_info.get('status', 'unknown'),
        })

    return {'processes': result, 'count': len(result)}


def _get_running_processes(params, config):
    """Get all running OS processes, optionally filtered by name."""
    name_filter = params.get('name_filter', '').lower()
    limit = min(params.get('limit', 50), 200)

    processes = []
    for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_info', 'status', 'create_time']):
        try:
            info = proc.info
            if name_filter and name_filter not in info['name'].lower():
                continue

            mem_mb = round(info['memory_info'].rss / (1024 * 1024), 1) if info['memory_info'] else 0

            processes.append({
                'pid': info['pid'],
                'name': info['name'],
                'cpu_percent': info['cpu_percent'] or 0,
                'memory_mb': mem_mb,
                'status': info['status'],
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    # Sort by memory usage descending
    processes.sort(key=lambda p: p['memory_mb'], reverse=True)
    processes = processes[:limit]

    return {'processes': processes, 'count': len(processes), 'total_running': len(list(psutil.process_iter()))}


def _get_gpu_processes(params, config):
    """Get per-process GPU memory (VRAM) usage via Windows Performance Counters.

    Uses the \\GPU Process Memory(*)\\ counters (same data source as Task Manager).
    This is the only reliable method on Windows WDDM — nvidia-smi and pynvml both
    return [N/A] or 0 for DirectX/OpenGL graphics processes. Works cross-vendor
    (NVIDIA, AMD, Intel).

    GPU-level totals (model, total/used VRAM) are enriched via pynvml if available.
    """
    # Step 1: Query Windows Performance Counters via PowerShell
    ps_script = (
        "$d = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -EA SilentlyContinue).CounterSamples;"
        "$s = (Get-Counter '\\GPU Process Memory(*)\\Shared Usage' -EA SilentlyContinue).CounterSamples;"
        "$r = @{dedicated=@(); shared=@()};"
        "foreach ($x in $d) { $r.dedicated += @{i=$x.InstanceName; v=$x.CookedValue} };"
        "foreach ($x in $s) { $r.shared += @{i=$x.InstanceName; v=$x.CookedValue} };"
        "$r | ConvertTo-Json -Depth 3 -Compress"
    )

    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps_script],
            capture_output=True, text=True, timeout=15,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        if result.returncode != 0 or not result.stdout.strip():
            return {'error': f'GPU Performance Counters unavailable: {result.stderr.strip() or "no output"}'}

        data = json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        return {'error': 'GPU Performance Counter query timed out.'}
    except (json.JSONDecodeError, Exception) as e:
        return {'error': f'Failed to parse GPU counter data: {e}'}

    # Step 2: Parse PIDs and aggregate per-process
    pid_pattern = re.compile(r'pid_(\d+)_')
    per_pid = {}  # pid -> {dedicated_bytes, shared_bytes}

    for entry in data.get('dedicated', []):
        match = pid_pattern.search(entry.get('i', ''))
        if not match:
            continue
        pid = int(match.group(1))
        per_pid.setdefault(pid, {'dedicated_bytes': 0, 'shared_bytes': 0})
        per_pid[pid]['dedicated_bytes'] += entry.get('v', 0)

    for entry in data.get('shared', []):
        match = pid_pattern.search(entry.get('i', ''))
        if not match:
            continue
        pid = int(match.group(1))
        per_pid.setdefault(pid, {'dedicated_bytes': 0, 'shared_bytes': 0})
        per_pid[pid]['shared_bytes'] += entry.get('v', 0)

    # Step 3: Resolve process names and build result list
    processes = []
    for pid, mem in per_pid.items():
        dedicated_mb = round(mem['dedicated_bytes'] / (1024 * 1024), 1)
        shared_mb = round(mem['shared_bytes'] / (1024 * 1024), 1)

        # Skip processes with negligible GPU memory (< 1 MB dedicated)
        if dedicated_mb < 1 and shared_mb < 1:
            continue

        proc_name = 'Unknown'
        try:
            proc_name = psutil.Process(pid).name()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

        processes.append({
            'pid': pid,
            'name': proc_name,
            'dedicated_gpu_mb': dedicated_mb,
            'shared_gpu_mb': shared_mb,
        })

    processes.sort(key=lambda p: p['dedicated_gpu_mb'], reverse=True)

    # Step 4: Enrich with GPU-level totals from pynvml (NVIDIA) or GPUtil
    gpu_info = _get_gpu_totals()

    return {
        'processes': processes,
        'process_count': len(processes),
        'gpu': gpu_info,
    }


def _get_gpu_totals():
    """Get GPU-level summary (model, total/used VRAM) from pynvml or GPUtil."""
    # Try pynvml first (more detailed)
    try:
        from pynvml import (
            nvmlInit, nvmlShutdown, nvmlDeviceGetCount,
            nvmlDeviceGetHandleByIndex, nvmlDeviceGetName,
            nvmlDeviceGetMemoryInfo,
        )
        nvmlInit()
        gpu_count = nvmlDeviceGetCount()
        gpus = []
        for i in range(gpu_count):
            handle = nvmlDeviceGetHandleByIndex(i)
            name = nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode('utf-8')
            mem = nvmlDeviceGetMemoryInfo(handle)
            gpus.append({
                'index': i,
                'name': name,
                'vram_total_mb': round(mem.total / (1024 * 1024)),
                'vram_used_mb': round(mem.used / (1024 * 1024)),
                'vram_free_mb': round(mem.free / (1024 * 1024)),
            })
        nvmlShutdown()
        return {'gpus': gpus, 'source': 'pynvml'}
    except Exception:
        pass

    # Fallback to GPUtil
    try:
        import GPUtil
        gpus_list = GPUtil.getGPUs()
        gpus = []
        for g in gpus_list:
            gpus.append({
                'index': g.id,
                'name': g.name,
                'vram_total_mb': round(g.memoryTotal),
                'vram_used_mb': round(g.memoryUsed),
                'vram_free_mb': round(g.memoryFree),
            })
        return {'gpus': gpus, 'source': 'GPUtil'}
    except Exception:
        pass

    return {'gpus': [], 'source': 'unavailable'}


def _get_network_info(params, config):
    """Get network interfaces and IP addresses."""
    interfaces = []
    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()

    for iface_name, addr_list in addrs.items():
        iface_stats = stats.get(iface_name)
        iface = {
            'name': iface_name,
            'is_up': iface_stats.isup if iface_stats else False,
            'speed_mbps': iface_stats.speed if iface_stats else 0,
            'addresses': [],
        }
        for addr in addr_list:
            if addr.family == socket.AF_INET:
                iface['addresses'].append({
                    'type': 'IPv4',
                    'address': addr.address,
                    'netmask': addr.netmask,
                })
            elif addr.family == socket.AF_INET6:
                iface['addresses'].append({
                    'type': 'IPv6',
                    'address': addr.address,
                })
        interfaces.append(iface)

    return {
        'hostname': socket.gethostname(),
        'interfaces': interfaces,
    }


def _get_disk_usage(params, config):
    """Get disk usage for all drives."""
    drives = []
    for partition in psutil.disk_partitions():
        try:
            usage = psutil.disk_usage(partition.mountpoint)
            drives.append({
                'device': partition.device,
                'mountpoint': partition.mountpoint,
                'fstype': partition.fstype,
                'total_gb': round(usage.total / (1024 ** 3), 2),
                'used_gb': round(usage.used / (1024 ** 3), 2),
                'free_gb': round(usage.free / (1024 ** 3), 2),
                'percent': usage.percent,
            })
        except (PermissionError, OSError):
            continue

    return {'drives': drives, 'count': len(drives)}


def _get_event_logs(params, config):
    """Get Windows event logs (Application, System, or Security)."""
    log_name = params.get('log_name', 'Application')
    max_events = min(params.get('max_events', 20), 100)
    level_filter = params.get('level', None)  # 'Error', 'Warning', 'Information'

    # Use PowerShell to query event logs
    ps_cmd = f'Get-EventLog -LogName {log_name} -Newest {max_events * 2}'
    if level_filter:
        ps_cmd += f' -EntryType {level_filter}'
    ps_cmd += ' | Select-Object -First ' + str(max_events) + ' TimeGenerated, EntryType, Source, Message | ConvertTo-Json -Depth 2'

    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps_cmd],
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        if result.returncode != 0:
            return {'error': f'Failed to query event logs: {result.stderr[:500]}'}

        events = json.loads(result.stdout) if result.stdout.strip() else []
        if isinstance(events, dict):
            events = [events]

        formatted = []
        now = datetime.now()
        for evt in events[:max_events]:
            raw_time = evt.get('TimeGenerated', '')
            timestamp = raw_time
            time_ago = ''
            # Parse PowerShell /Date(...)/ format into readable timestamp + relative time
            if isinstance(raw_time, str) and '/Date(' in raw_time:
                try:
                    ms = int(raw_time.split('(')[1].split(')')[0])
                    dt = datetime.fromtimestamp(ms / 1000)
                    timestamp = dt.strftime('%Y-%m-%d %H:%M:%S')
                    delta = now - dt
                    if delta.days > 365:
                        years = delta.days // 365
                        time_ago = f'{years} year{"s" if years != 1 else ""} ago'
                    elif delta.days > 30:
                        months = delta.days // 30
                        time_ago = f'{months} month{"s" if months != 1 else ""} ago'
                    elif delta.days > 0:
                        time_ago = f'{delta.days} day{"s" if delta.days != 1 else ""} ago'
                    elif delta.seconds >= 3600:
                        hours = delta.seconds // 3600
                        time_ago = f'{hours} hour{"s" if hours != 1 else ""} ago'
                    elif delta.seconds >= 60:
                        mins = delta.seconds // 60
                        time_ago = f'{mins} minute{"s" if mins != 1 else ""} ago'
                    else:
                        time_ago = 'just now'
                except (ValueError, IndexError):
                    pass  # Keep raw timestamp if parsing fails

            entry = {
                'time': timestamp,
                'level': evt.get('EntryType', ''),
                'source': evt.get('Source', ''),
                'message': (evt.get('Message', '') or '')[:500],
            }
            if time_ago:
                entry['time_ago'] = time_ago
            formatted.append(entry)

        return {'log_name': log_name, 'events': formatted, 'count': len(formatted)}

    except subprocess.TimeoutExpired:
        return {'error': 'Event log query timed out'}
    except json.JSONDecodeError:
        return {'error': 'Failed to parse event log output'}


def _get_service_status(params, config):
    """Get Windows service status by name, including start type for proper interpretation."""
    service_name = params.get('service_name')
    if not service_name:
        return {'error': 'service_name parameter is required'}

    try:
        import win32service
        import win32serviceutil

        status = win32serviceutil.QueryServiceStatus(service_name)
        state_map = {
            win32service.SERVICE_STOPPED: 'stopped',
            win32service.SERVICE_START_PENDING: 'start_pending',
            win32service.SERVICE_STOP_PENDING: 'stop_pending',
            win32service.SERVICE_RUNNING: 'running',
            win32service.SERVICE_CONTINUE_PENDING: 'continue_pending',
            win32service.SERVICE_PAUSE_PENDING: 'pause_pending',
            win32service.SERVICE_PAUSED: 'paused',
        }

        # Query the service start type for proper context
        start_type = 'unknown'
        try:
            scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_CONNECT)
            try:
                svc = win32service.OpenService(scm, service_name, win32service.SERVICE_QUERY_CONFIG)
                try:
                    cfg = win32service.QueryServiceConfig(svc)
                    start_type_map = {
                        win32service.SERVICE_AUTO_START: 'automatic',
                        win32service.SERVICE_BOOT_START: 'boot',
                        win32service.SERVICE_DEMAND_START: 'demand_start',
                        win32service.SERVICE_DISABLED: 'disabled',
                        win32service.SERVICE_SYSTEM_START: 'system',
                    }
                    start_type = start_type_map.get(cfg[1], 'unknown')
                finally:
                    win32service.CloseServiceHandle(svc)
            finally:
                win32service.CloseServiceHandle(scm)
        except Exception:
            pass  # Non-critical — status is still valid without start type

        result = {
            'service_name': service_name,
            'status': state_map.get(status[1], 'unknown'),
            'start_type': start_type,
            'service_type': status[0],
            'current_state': status[1],
        }

        # Add interpretive note for demand-start services that are stopped (normal idle state)
        if result['status'] == 'stopped' and start_type == 'demand_start':
            result['note'] = (
                'This is a demand-start service — it starts only when needed and stops when idle. '
                'A "stopped" status is normal and does NOT mean the service is disabled or broken. '
                'For Windows Update (wuauserv), "stopped" means no update check or install is '
                'currently in progress; updates are still enabled unless the start type is "disabled".'
            )

        return result
    except Exception as e:
        return {'error': f'Failed to query service {service_name}: {e}'}


def _get_agent_config(params, config):
    """Get current agent configuration (sanitized — no secrets)."""
    if not config:
        config = shared_utils.read_config()

    if not config:
        return {'error': 'Unable to read agent configuration'}

    # Return config but strip sensitive fields
    safe_config = {}
    for key, val in config.items():
        if key in ('firebase',):
            # Include firebase section but strip auth tokens
            fb = dict(val) if isinstance(val, dict) else {}
            fb.pop('refresh_token', None)
            fb.pop('access_token', None)
            safe_config[key] = fb
        else:
            safe_config[key] = val

    return {
        'config': safe_config,
        'config_path': shared_utils.CONFIG_PATH,
        'version': shared_utils.get_app_version(),
    }


def _get_agent_logs(params, config):
    """Get recent Owlette agent log entries."""
    max_lines = min(params.get('max_lines', 100), 500)
    level_filter = params.get('level', None)  # 'ERROR', 'WARNING', 'INFO', 'DEBUG'

    log_dir = shared_utils.get_data_path('logs')
    if not os.path.isdir(log_dir):
        return {'error': 'Log directory not found', 'log_dir': log_dir}

    # Find most recent log file
    log_files = sorted(
        [f for f in os.listdir(log_dir) if f.endswith('.log')],
        reverse=True
    )

    if not log_files:
        return {'error': 'No log files found', 'log_dir': log_dir}

    log_path = os.path.join(log_dir, log_files[0])

    try:
        with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()

        # Filter by level if specified
        if level_filter:
            level_filter_upper = level_filter.upper()
            lines = [l for l in lines if level_filter_upper in l]

        # Return last N lines
        recent = lines[-max_lines:]

        return {
            'log_file': log_files[0],
            'lines': [l.rstrip() for l in recent],
            'count': len(recent),
            'total_lines': len(lines),
        }
    except Exception as e:
        return {'error': f'Failed to read log file: {e}'}


def _get_agent_health(params, config):
    """Get agent health and connection status."""
    from health_probe import HealthProbe

    probe = HealthProbe()
    health = probe.check()

    return {
        'status': health.get('status', 'unknown'),
        'checks': health.get('checks', {}),
        'version': shared_utils.get_app_version(),
        'hostname': socket.gethostname(),
        'uptime_seconds': int(time.time() - psutil.boot_time()),
    }


# ─── Tier 3: Privileged Tools ───────────────────────────────────────────────


def _run_command(params, config):
    """Execute a shell command (validated against allow-list).

    Security: uses shell=False with shlex.split() to prevent shell injection
    via metacharacters (&&, |, ;, etc.). Only the first token is validated
    against the allow-list; remaining tokens are passed as arguments.
    """
    command = params.get('command', '').strip()
    if not command:
        return {'error': 'command parameter is required'}

    # Parse command into a safe token list (no shell interpretation).
    # posix=False preserves Windows backslashes in paths (POSIX mode treats \ as escape).
    try:
        cmd_parts = shlex.split(command, posix=False)
    except ValueError as e:
        return {'error': f'Invalid command syntax: {e}'}

    if not cmd_parts:
        return {'error': 'command parameter is required'}

    # Validate first token against allow-list
    allowed = _get_allowed_commands(config)
    cmd_base = cmd_parts[0].lower()

    if not any(cmd_base == a.lower() for a in allowed):
        return {
            'error': f"Command '{cmd_base}' is not in the allow-list. Allowed: {', '.join(sorted(set(a.lower() for a in allowed)))}",
        }

    logger.info(f"[MCP-AUDIT] run_command: {cmd_base} (args: {len(cmd_parts) - 1})")

    try:
        result = subprocess.run(
            cmd_parts,
            capture_output=True, text=True, shell=False,
            timeout=SUBPROCESS_TIMEOUT,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        stdout = result.stdout[:MAX_OUTPUT_SIZE]
        stderr = result.stderr[:MAX_OUTPUT_SIZE]

        return {
            'command': command,
            'exit_code': result.returncode,
            'stdout': stdout,
            'stderr': stderr,
        }
    except subprocess.TimeoutExpired:
        return {'error': f'Command timed out after {SUBPROCESS_TIMEOUT} seconds'}


def _run_powershell(params, config):
    """Execute a PowerShell command (validated against allow-list)."""
    script = params.get('script', '').strip()
    if not script:
        return {'error': 'script parameter is required'}

    # Validate the first command/cmdlet against allow-list
    allowed = _get_allowed_commands(config)
    # Extract first token (cmdlet name)
    first_token = script.split()[0].rstrip(';') if script else ''

    if not any(first_token.lower() == a.lower() for a in allowed):
        return {
            'error': f"Command '{first_token}' is not in the allow-list. Allowed: {', '.join(sorted(set(a.lower() for a in allowed)))}",
        }

    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command', script],
            capture_output=True, text=True,
            timeout=SUBPROCESS_TIMEOUT,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        stdout = result.stdout[:MAX_OUTPUT_SIZE]
        stderr = result.stderr[:MAX_OUTPUT_SIZE]

        return {
            'script': script,
            'exit_code': result.returncode,
            'stdout': stdout,
            'stderr': stderr,
        }
    except subprocess.TimeoutExpired:
        return {'error': f'PowerShell command timed out after {SUBPROCESS_TIMEOUT} seconds'}


def _execute_script(params, config):
    """Execute a PowerShell script with no command restrictions.

    Uses Popen with a job object so the entire process tree (including
    child processes spawned by Start-Job, Start-Process, etc.) is killed
    on timeout instead of leaving orphans.
    """
    script = params.get('script', '').strip()
    if not script:
        return {'error': 'script parameter is required'}

    timeout = params.get('timeout_seconds', 120)
    cwd = params.get('working_directory', None)

    if cwd and not os.path.isdir(cwd):
        return {'error': f'Working directory not found: {cwd}'}

    logger.info(f"[MCP-AUDIT] execute_script called. Script length: {len(script)} chars, timeout: {timeout}s")

    # -ExecutionPolicy Bypass is required for kiosks with Group Policy set to
    # AllSigned/Restricted. It's not a security boundary (SYSTEM can already
    # do anything), it's a compatibility flag for hardened deployments.
    proc = subprocess.Popen(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        cwd=cwd,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
    )

    try:
        stdout, stderr = proc.communicate(timeout=timeout)

        return {
            'script': script[:500],
            'exit_code': proc.returncode,
            'stdout': stdout[:MAX_OUTPUT_SIZE],
            'stderr': stderr[:MAX_OUTPUT_SIZE],
            'timed_out': False,
        }
    except subprocess.TimeoutExpired:
        # Kill the entire process tree, not just the root
        _kill_process_tree(proc.pid)
        # Drain any remaining output
        stdout, stderr = proc.communicate(timeout=5)

        return {
            'script': script[:500],
            'stdout': (stdout or '')[:MAX_OUTPUT_SIZE],
            'stderr': (stderr or '')[:MAX_OUTPUT_SIZE],
            'error': f'Script timed out after {timeout} seconds — all child processes have been terminated',
            'timed_out': True,
        }
    except Exception:
        _kill_process_tree(proc.pid)
        raise


def _get_allowed_file_bases(config):
    """Build the list of allowed base directories for file I/O.

    Includes Owlette data dirs, user profile, temp, and directories of any
    configured processes (so Cortex can inspect/write project files).
    """
    data_path = os.environ.get('ProgramData', r'C:\ProgramData')
    bases = [
        os.path.join(data_path, 'Owlette'),
        os.path.expandvars('%TEMP%'),
        os.path.expandvars('%USERPROFILE%'),
    ]
    # Add directories of configured processes (e.g. TouchDesigner projects)
    for proc in (config or {}).get('processes', []):
        proc_path = proc.get('path', '')
        if proc_path:
            bases.append(os.path.dirname(proc_path))
    # Resolve all to real paths for consistent comparison
    return [os.path.realpath(b) for b in bases if b]


def _validate_file_path(file_path, config):
    """Validate that a file path is within allowed directories.

    Returns (ok, resolved_path_or_error).
    Uses case-insensitive comparison (Windows) with path-separator check
    to prevent prefix collisions (e.g. OwletteEVIL matching Owlette).
    """
    resolved = os.path.realpath(file_path)
    resolved_lower = resolved.lower()
    for base in _get_allowed_file_bases(config):
        base_lower = base.lower()
        if resolved_lower.startswith(base_lower):
            # Ensure it's truly under base, not just a prefix match
            # e.g. "C:\ProgramData\OwletteEVIL" must NOT match "C:\ProgramData\Owlette"
            if len(resolved_lower) == len(base_lower) or resolved_lower[len(base_lower)] in ('\\', '/'):
                return True, resolved
    return False, f"Path is outside allowed directories: {file_path}"


def _read_file(params, config):
    """Read file contents with size limit and path validation."""
    file_path = params.get('path', '').strip()
    if not file_path:
        return {'error': 'path parameter is required'}

    ok, result = _validate_file_path(file_path, config)
    if not ok:
        logger.warning(f"[MCP-AUDIT] read_file BLOCKED: {result}")
        return {'error': result}

    resolved = result

    if not os.path.isfile(resolved):
        return {'error': f'File not found: {file_path}'}

    file_size = os.path.getsize(resolved)
    max_size = 100 * 1024  # 100 KB

    if file_size > max_size:
        return {'error': f'File too large ({file_size} bytes). Maximum: {max_size} bytes'}

    logger.info(f"[MCP-AUDIT] read_file: {resolved} ({file_size} bytes)")

    try:
        with open(resolved, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()

        return {
            'path': file_path,
            'content': content,
            'size_bytes': file_size,
            'lines': content.count('\n') + 1,
        }
    except Exception as e:
        return {'error': f'Failed to read file: {e}'}


def _write_file(params, config):
    """Write content to a file with path validation."""
    file_path = params.get('path', '').strip()
    content = params.get('content', '')

    if not file_path:
        return {'error': 'path parameter is required'}

    ok, result = _validate_file_path(file_path, config)
    if not ok:
        logger.warning(f"[MCP-AUDIT] write_file BLOCKED: {result}")
        return {'error': result}

    resolved = result

    logger.info(f"[MCP-AUDIT] write_file: {resolved} ({len(content)} chars)")

    try:
        # Ensure directory exists
        dir_path = os.path.dirname(resolved)
        if dir_path and not os.path.isdir(dir_path):
            os.makedirs(dir_path, exist_ok=True)

        with open(resolved, 'w', encoding='utf-8') as f:
            f.write(content)

        return {
            'path': file_path,
            'size_bytes': len(content.encode('utf-8')),
            'status': 'written',
        }
    except Exception as e:
        return {'error': f'Failed to write file: {e}'}


def _list_directory(params, config):
    """List directory contents."""
    dir_path = params.get('path', '').strip()
    if not dir_path:
        return {'error': 'path parameter is required'}

    if not os.path.isdir(dir_path):
        return {'error': f'Directory not found: {dir_path}'}

    try:
        entries = []
        for entry in os.scandir(dir_path):
            info = {
                'name': entry.name,
                'is_dir': entry.is_dir(),
                'is_file': entry.is_file(),
            }
            try:
                stat = entry.stat()
                info['size_bytes'] = stat.st_size if entry.is_file() else None
                info['modified'] = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stat.st_mtime))
            except OSError:
                pass
            entries.append(info)

        # Sort: directories first, then by name
        entries.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))

        return {
            'path': dir_path,
            'entries': entries[:200],
            'count': len(entries),
        }
    except Exception as e:
        return {'error': f'Failed to list directory: {e}'}


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _kill_process_tree(pid):
    """Kill a process and all its descendants using psutil."""
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
        # Kill children first (bottom-up), then the parent
        for child in reversed(children):
            try:
                child.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        parent.kill()
        # Wait briefly for processes to actually terminate
        psutil.wait_procs(children + [parent], timeout=5)
    except psutil.NoSuchProcess:
        pass  # Already dead
    except Exception as e:
        logger.warning(f"Failed to kill process tree (PID {pid}): {e}")


def _get_allowed_commands(config):
    """Get the command allow-list from config or use defaults."""
    if config and 'mcp' in config:
        custom = config['mcp'].get('allowed_commands', [])
        if custom:
            return custom
    return DEFAULT_ALLOWED_COMMANDS
