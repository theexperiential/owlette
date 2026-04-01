# Admin Panel

The Admin Panel provides management tools for users, agent installers, system presets, schedule presets, tokens, alerts, webhooks, and email settings. Only users with the **admin** role can access these features.

---

## Becoming an Admin

The first admin must be created manually:

1. Register a user account in the dashboard
2. Go to Firebase Console → Firestore → `users` collection
3. Find your user document
4. Change `role` from `"user"` to `"admin"`
5. Log out and log back in

After that, admins can promote other users from the Admin Panel.

---

## Access

- **Profile menu** → "Admin Panel"
- **Direct URLs**: `/admin/users`, `/admin/installers`, `/admin/presets`, `/admin/schedules`, `/admin/tokens`, `/admin/alerts`, `/admin/webhooks`, `/admin/email`

Non-admin users are redirected to the dashboard with an error message.

---

## Admin vs User Permissions

| Capability | User | Admin |
|-----------|------|-------|
| View assigned sites | Yes | Yes (all sites) |
| Monitor machines | Yes | Yes |
| Manage processes | Yes | Yes |
| Create deployments | Yes | Yes |
| Create distributions | Yes | Yes |
| Use Cortex | Yes | Yes |
| View activity logs | Yes | Yes |
| **Manage users** | No | **Yes** |
| **Upload installers** | No | **Yes** |
| **Manage system presets** | No | **Yes** |
| **Manage agent tokens** | No | **Yes** |
| **Manage schedule presets** | No | **Yes** |
| **Configure threshold alerts** | No | **Yes** |
| **Configure webhooks** | No | **Yes** |
| **Send test emails** | No | **Yes** |
| **Set site-level LLM keys** | No | **Yes** |
| **Simulate events** | No | **Yes** |

---

## In This Section

- [**User Management**](user-management.md) — View users, assign roles, manage site access
- [**Installer Management**](installer-management.md) — Upload and manage agent versions
- [**System Presets**](system-presets.md) — Save and apply process configurations
- **Schedule Presets** (`/admin/schedules`) — Reusable schedule configurations for process launch times
- [**Token Management**](token-management.md) — View and revoke agent tokens
- **Threshold Alerts** (`/admin/alerts`) — CPU, memory, disk, and process alert rules
- [**Webhooks**](webhooks.md) — Outbound HTTP webhooks for external integrations
- [**Email Alerts**](email-alerts.md) — Email notification settings and testing
