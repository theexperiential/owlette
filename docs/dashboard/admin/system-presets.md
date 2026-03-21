# System Presets

System presets let you save and apply process configurations across multiple machines. Define a set of processes once, then apply the preset to any machine to instantly configure it.

**Location**: Admin Panel → System Presets (`/admin/presets`)

---

## What's in a Preset

A preset contains a list of process configurations:

- Process name
- Executable path
- File path
- Command-line arguments
- Autolaunch setting
- Priority
- Visibility
- Launch delay
- Init time
- Relaunch attempts

---

## Creating a Preset

1. Navigate to **System Presets** in the Admin Panel
2. Click **"New Preset"**
3. Enter a **preset name** (e.g., "Digital Signage Standard")
4. Add processes with their configurations
5. Click **Save**

---

## Applying a Preset

1. Select a machine in the dashboard
2. Open the **System Preset Dialog**
3. Choose a preset from the list
4. Click **Apply**
5. The machine's process configuration is replaced with the preset's processes

!!! warning
    Applying a preset **replaces** all existing process configurations on the target machine. The current configuration is overwritten.

---

## Use Cases

- **Standardize configurations** — Ensure all signage machines run the same processes
- **Quick setup** — Apply a preset to new machines instead of configuring each one manually
- **Environment templates** — Different presets for different machine roles (e.g., "Kiosk", "Media Server", "Development")
