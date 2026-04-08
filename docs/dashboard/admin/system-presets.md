# system presets

System presets let you save and apply process configurations across multiple machines. Define a set of processes once, then apply the preset to any machine to instantly configure it.

**Location**: Admin Panel → System Presets (`/admin/presets`)

---

## what's in a preset

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

## creating a preset

1. Navigate to **System Presets** in the Admin Panel
2. Click **"New Preset"**
3. Enter a **preset name** (e.g., "Digital Signage Standard")
4. Add processes with their configurations
5. Click **Save**

---

## applying a preset

1. Select a machine in the dashboard
2. Open the **System Preset Dialog**
3. Choose a preset from the list
4. Click **Apply**
5. The machine's process configuration is replaced with the preset's processes

!!! warning
    Applying a preset **replaces** all existing process configurations on the target machine. The current configuration is overwritten.

---

## use cases

- **Standardize configurations** — Ensure all signage machines run the same processes
- **Quick setup** — Apply a preset to new machines instead of configuring each one manually
- **Environment templates** — Different presets for different machine roles (e.g., "Kiosk", "Media Server", "Development")
