"""LibreHardwareMonitor-backed temperature sensors (PawnIO era).

Replaces WinTmp, which bundled a pre-PawnIO LibreHardwareMonitorLib and
extracted the blocklisted WinRing0 driver at runtime (python.sys / R0python).
The HardwareMonitor package wraps LHM 0.9.6, which talks to the PawnIO driver
the Owlette installer deploys. Without PawnIO the CLR side still loads: CPU
sensors enumerate with null values and GPU temps keep arriving through vendor
userspace APIs (NVAPI/ADL), so every degraded path lands on None -- never an
extracted driver.

Callers: shared_utils.get_cpu_temperature / get_gpu_temperatures, which own
the config gate, the timeout watchdog, the 0 < t < 150 sanity filter, and the
pynvml fallback. This module deliberately reads no config and swallows no
exceptions -- shared_utils handles both.
"""
import threading

# One Computer per process: Open() loads the CLR and binds the PawnIO device,
# which costs ~1.5s cold -- per-read open/close would blow the 3s watchdog.
# The lock serializes Update() across the heartbeat thread and ad-hoc readers
# (LHM's visitor pattern is not thread-safe). The handle is released at
# process exit; there is no re-extraction or service registration to undo.
_lock = threading.Lock()
_computer = None

# Preferred CPU sensors, most-specific first: Intel package, AMD Tctl/Tdie,
# then LHM's cross-core max. "Distance to TjMax" sensors are headroom values
# (TjMax minus temp), not temperatures -- WinTmp naively mixed them in.
_CPU_PREFERRED = ('CPU Package', 'Core (Tctl/Tdie)', 'Core (Tctl)', 'Core Max')


def _ensure_computer():
    global _computer
    if _computer is None:
        from HardwareMonitor.Hardware import Computer

        computer = Computer()
        computer.IsCpuEnabled = True
        computer.IsGpuEnabled = True
        computer.Open()
        _computer = computer
    return _computer


def _temperature_values(hardware):
    """{sensor name: float value} for the hardware item's readable temps."""
    from HardwareMonitor.Hardware import SensorType

    values = {}
    for sensor in hardware.Sensors:
        if sensor.SensorType == SensorType.Temperature and sensor.Value is not None:
            values[str(sensor.Name)] = float(sensor.Value)
    return values


def read_cpu_temperature():
    """Package temperature of the first CPU in Celsius, or None."""
    with _lock:
        computer = _ensure_computer()
        for hardware in computer.Hardware:
            if str(hardware.HardwareType) != 'Cpu':
                continue
            hardware.Update()
            values = _temperature_values(hardware)
            for name in _CPU_PREFERRED:
                if name in values:
                    return values[name]
            for name, value in values.items():
                if 'Tctl' in name or 'Tdie' in name:
                    return value
            usable = [v for n, v in values.items() if 'Distance to TjMax' not in n]
            if usable:
                return max(usable)
        return None


def read_gpu_temperatures():
    """Core temperature per GPU in Celsius, LHM enumeration order.

    One entry per Gpu* hardware item, None when that GPU has no readable
    temperature. Positional order is the contract -- shared_utils joins these
    onto the hardware profile's GPU list by index.
    """
    with _lock:
        computer = _ensure_computer()
        temps = []
        for hardware in computer.Hardware:
            if not str(hardware.HardwareType).startswith('Gpu'):
                continue
            hardware.Update()
            values = _temperature_values(hardware)
            if 'GPU Core' in values:
                temps.append(values['GPU Core'])
            elif values:
                temps.append(next(iter(values.values())))
            else:
                temps.append(None)
        return temps
