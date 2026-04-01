# Machine Monitoring

The dashboard provides real-time visibility into all your machines' health, performance, and process status.

---

## Machine Status

### Online/Offline Detection

The agent sends a **heartbeat** to Firestore every 30 seconds. The dashboard considers a machine:

| Status | Condition | Indicator |
|--------|-----------|-----------|
| **Online** | Heartbeat within last 3 minutes | Green dot |
| **Offline** | No heartbeat for 3+ minutes | Red/grey dot |
| **Stale** | Heartbeat is older than expected but within threshold | Yellow dot |

### Last Seen

Each machine shows a "last seen" timestamp. For offline machines, this tells you when the machine last communicated.

---

## System Metrics

Metrics are reported by the agent every 60 seconds:

| Metric | Range | Source |
|--------|-------|--------|
| **CPU** | 0-100% | Overall CPU utilization |
| **Memory** | 0-100% | RAM usage percentage |
| **Disk** | 0-100% | Primary disk usage |
| **GPU** | 0-100% | GPU utilization (NVIDIA via NVML, others via WinTmp) |

### Color Coding

Metrics use traffic-light colors:

| Color | Threshold | Meaning |
|-------|-----------|---------|
| Green | 0-60% | Healthy |
| Yellow | 60-80% | Warning |
| Red | 80-100% | Critical |

---

## View Modes

### Card View

The default view displays each machine as a card:

- Machine name and status indicator
- CPU, memory, disk, GPU meters with percentages
- Sparkline mini-charts showing recent trends
- Process list with status badges
- Agent version

Click a machine card to expand details.

### List View

A compact table view with sortable columns:

- Machine name
- Status (online/offline)
- CPU, Memory, Disk, GPU values
- Process count
- Last heartbeat
- Agent version

Useful when managing many machines.

---

## Sparkline Charts

Each metric in card view shows a tiny sparkline chart representing recent values. These give you an at-a-glance trend without clicking into the machine.

---

## Historical Metrics

Click on a machine to view detailed historical metrics:

### Time Ranges

| Range | Resolution | Data Points |
|-------|-----------|-------------|
| **24 hours** | 1 minute | ~1,440 points |
| **7 days** | 15 minutes | ~672 points |
| **30 days** | 1 hour | ~720 points |

### Charts

The metrics detail panel shows interactive Recharts line graphs for:

- CPU usage over time
- Memory usage over time
- Disk usage over time
- GPU usage over time (if available)

Hover over data points for exact values and timestamps.

---

## Process Status

Each machine card shows its configured processes with status badges:

| Badge | State | Meaning |
|-------|-------|---------|
| Green | RUNNING | Process is alive and responding |
| Yellow | STALLED | Process exists but not responding |
| Red | KILLED | Process was terminated |
| Grey | STOPPED | Process not running, autolaunch off |
| Grey (dim) | INACTIVE | Executable not found |

Click a process to open the [Process Dialog](process-management.md) for management and configuration.

---

## Machine Information

Each machine reports additional details:

| Field | Description |
|-------|-------------|
| **Hostname** | Windows computer name (used as machine ID) |
| **OS** | Windows version (e.g., "Windows 11 Pro 10.0.22631") |
| **CPU Model** | Processor name (e.g., "Intel Core i9-9900X") |
| **Agent Version** | Installed owlette version (e.g., "2.1.8") |
| **Uptime** | Time since last agent start |
