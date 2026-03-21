# Process Management

Add, configure, and control processes from the web dashboard. Changes sync to the agent within ~1-2 seconds.

---

## Adding a Process

1. Click on a machine in the dashboard
2. Click **"Add Process"**
3. Fill in the configuration:
    - **Name**: Display name (e.g., "TouchDesigner")
    - **Executable Path**: Full path to the `.exe` file
    - **File Path** (optional): File to open with the executable (e.g., `.toe` project)
    - **Arguments** (optional): Command-line arguments
    - **Autolaunch**: Enable to auto-start and auto-restart
    - **Priority**: Windows process priority
    - **Visibility**: Normal or Hidden
    - **Launch Delay**: Seconds to wait before starting
    - **Init Time**: Seconds before monitoring responsiveness
    - **Relaunch Attempts**: Max restarts before reboot prompt
4. Click **Save**

The agent receives the new configuration and begins monitoring the process.

---

## Editing a Process

1. Click on a process in a machine card
2. The **Process Dialog** opens with current settings
3. Edit any fields
4. Click **Save**

Changes propagate through Firestore to the agent immediately.

---

## Process Actions

From the Process Dialog or machine card, you can:

| Action | Description | Requires |
|--------|-------------|----------|
| **Start** | Launch the process | Process must be stopped |
| **Stop / Kill** | Terminate the process | Process must be running |
| **Restart** | Kill and relaunch | Process must be running |
| **Toggle Autolaunch** | Enable/disable auto-restart | Any state |
| **Delete** | Remove from configuration | Any state |

All actions send commands to the agent via Firestore and complete within seconds.

---

## Process Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Name** | string | required | Display name for identification |
| **Executable Path** | string | required | Full path to `.exe` (e.g., `C:\Program Files\App\app.exe`) |
| **File Path** | string | `""` | File to open (e.g., `.toe`, `.py`, `.html`) |
| **Command Line Args** | string | `""` | Additional arguments passed to the executable |
| **Autolaunch** | boolean | `true` | Auto-start on service boot + auto-restart on crash |
| **Priority** | enum | `Normal` | `Idle`, `Below Normal`, `Normal`, `Above Normal`, `High`, `Realtime` |
| **Visibility** | enum | `Normal` | `Normal` (visible window) or `Hidden` (no window) |
| **Launch Delay** | number | `0` | Seconds to wait before launching (for boot ordering) |
| **Init Time** | number | `10` | Grace period before monitoring responsiveness |
| **Relaunch Attempts** | number | `5` | Max crash-restarts before prompting for system reboot |

---

## Tips

!!! tip "Launch ordering"
    Use **Launch Delay** to control startup order. For example, set a database to 0s delay and the application that depends on it to 15s.

!!! tip "Hidden processes"
    Use **Hidden** visibility for background services like Node.js servers or Python scripts that don't need a window.

!!! warning "Realtime priority"
    Setting priority to **Realtime** can starve other processes and make the machine unresponsive. Use with extreme caution.
