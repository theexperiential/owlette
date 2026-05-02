# system presets

System presets are the platform template library for software deployments. They are global installer presets, not process configuration presets.

**Location**: Admin Panel -> template library (`/admin/presets`)

**Storage**: Firestore `system_presets/{presetId}`

**API**: `/api/platform/system-presets`

---

## who manages them

Superadmins manage system presets from the admin template library. The admin route is wrapped by the superadmin-only admin layout, and the platform API requires the `SYSTEM_PRESET_MANAGE` capability.

All authenticated users can read `system_presets` from Firestore. Create, update, and delete writes go through trusted server routes and service-account writes, not direct client writes.

Site admins use these presets when creating deployments. The deployment dialog treats system presets as catalog entries; it does not let site admins overwrite the global library.

---

## template library

The page shows a categorized software catalog. Each row represents one installer template and includes:

| column | description |
|--------|-------------|
| **preset** | Software name plus display name, with an auto-update badge for special Owlette Agent presets |
| **category** | Category used for filtering |
| **installer** | Installer filename and installer URL preview |
| **flags** | Silent install flags |
| **actions** | Edit or delete the preset |

Category tabs are generated from the stored `category` values. The create/edit dialog offers these standard categories: `System`, `Creative Software`, `Media Server`, `Utilities`, and `Development Tools`.

---

## preset fields

System preset documents may contain:

| field | required | description |
|-------|----------|-------------|
| `name` | Yes | Display name shown in the template dropdown, such as `TouchDesigner 2025.31550` |
| `software_name` | Yes | Short software identifier used for grouping and matching, such as `TouchDesigner` |
| `category` | Yes | Template category used by the admin filters and deployment dialog groups |
| `description` | No | Optional long description |
| `icon` | No | Optional one-character icon for display |
| `installer_name` | Yes | Installer filename, such as `TouchDesigner.2025.31550.exe` |
| `installer_url` | Usually | Direct installer download URL. The admin dialog requires it for normal templates; special agent presets may resolve the installer elsewhere. |
| `silent_flags` | Yes | Command-line flags for unattended installation |
| `verify_path` | No | File path checked after installation to confirm success |
| `close_processes` | No | Process executable names to close before install |
| `parallel_install` | No | Whether to keep existing versions by installing alongside them |
| `is_owlette_agent` | Yes | Marks special Owlette Agent presets; normal admin-created templates set this to `false` |
| `timeout_seconds` | No | Custom install timeout; the admin dialog defaults to `600` seconds |
| `order` | Yes | Display order; lower values sort first |
| `createdBy` | Yes | User ID of the superadmin who created the preset |
| `createdAt` | Yes | Server timestamp for creation |
| `updatedAt` | No | Server timestamp for the most recent update |

The API creates IDs with the `preset-{software-slug}-{epochMs}` pattern. Individual preset routes accept IDs made from letters, digits, underscores, and hyphens.

---

## creating and editing templates

1. Open **template library** in the admin panel.
2. Click **add template**.
3. Fill in the required software, category, installer, URL, and silent flag fields.
4. Optionally add a description, icon, verification path, timeout, and display order.
5. Click **create template**.

For TouchDesigner templates, the dialog can fetch the latest build from derivative.ca and prefill the name, installer filename, installer URL, silent flags, verification path, timeout, and sort order.

Editing writes a partial update and stamps `updatedAt`. Deleting removes the preset document; there is no soft-delete state for system presets.

---

## use in deployments

The deployment dialog uses system presets in the **template** dropdown:

1. It reads the global `system_presets` catalog.
2. It filters out entries where `is_owlette_agent` is `true`.
3. It groups the remaining system presets by `category`.
4. It lists site-saved deployment templates separately under **Saved**.

Selecting a system preset fills the deployment form with:

- deployment name derived from `software_name`
- `installer_name`
- `installer_url`
- `silent_flags`
- `verify_path`
- `parallel_install`
- `close_processes`

Deployment template edit/save/delete controls are hidden while a system preset is selected. Saved deployment templates are site-scoped records; system presets remain platform-wide catalog entries managed only from the admin template library.

---

## not process presets

System presets do not store process lists, executable paths, window visibility, launch modes, schedules, or relaunch settings. They are not applied to a machine's process configuration. Use the process management page for process configuration.
