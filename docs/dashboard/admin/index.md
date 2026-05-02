# admin panel

The Admin Panel provides management tools for users, agent installers, system presets, schedule presets, tokens, alerts, webhooks, and email settings. Only users with the **superadmin** role can access these platform-wide features. Site-scoped admin capabilities (machine commands and configuration, deployments, roosts, webhooks, logs, and site members on assigned sites) live on the site dashboard and are available to both `admin` and `superadmin` roles.

---

## roles at a glance

Owlette uses a three-tier role model:

| role | platform access | site access |
|------|-----------------|-------------|
| **member** | none | read-only on assigned sites |
| **admin** | none | write access on assigned sites (machine commands/configuration, deployments, roosts, webhooks, logs, site members) |
| **superadmin** | full Admin Panel | implicit access to every site, regardless of assignment |

Only superadmins can access the Admin Panel routes. Admins are site-scoped — they get elevated controls on sites listed in their `sites` array, but cannot manage users, upload installers, or access sites they aren't assigned to.

---

## becoming a superadmin

The first superadmin must be created manually:

1. Register a user account in the dashboard
2. Go to Firebase Console → Firestore → `users` collection
3. Find your user document
4. Change `role` from `"member"` to `"superadmin"`
5. Log out and log back in

After that, superadmins can promote other users to `admin` or `superadmin` from the Admin Panel's user-management page.

---

## access

- **Profile menu** → "Admin Panel" (visible only to superadmins)
- **Direct URLs**: `/admin/users`, `/admin/installers`, `/admin/presets`, `/admin/schedules`, `/admin/tokens`, `/admin/alerts`, `/admin/webhooks`, `/admin/email`

Members and site-admins are redirected to the dashboard with an error message.

---

## capability matrix

Read access to assigned sites is baseline role behavior, not a `Capability` enum value. The capability rows below mirror `RoleCapabilityMatrix` in `web/lib/capabilities.ts`; site-scoped grants apply only to the admin's assigned sites, while superadmins have all-site scope.

| capability | member | admin | superadmin | scope |
|-----------|:------:|:-----:|:----------:|-------|
| Assigned-site read access | yes | yes | yes, all sites | site assignment / global |
| `USER_SELF_PREFS` | yes | yes | yes | self |
| `USER_SELF_DELETE` | yes | yes | yes | self |
| `MACHINE_EXEC_COMMAND` | no | yes | yes | assigned sites / all sites |
| `MACHINE_CONFIG_WRITE` | no | yes | yes | assigned sites / all sites |
| `MACHINE_REMOVE` | no | no | yes | all sites |
| `DEPLOYMENT_MANAGE` | no | yes | yes | assigned sites / all sites |
| `DISTRIBUTION_MANAGE` (roost) | no | yes | yes | assigned sites / all sites |
| `UNINSTALL_TRIGGER` | no | yes | yes | assigned sites / all sites |
| `PRESET_MANAGE` (site presets) | no | yes | yes | assigned sites / all sites |
| `SITE_MEMBER_MANAGE` | no | yes | yes | assigned sites / all sites |
| `WEBHOOK_MANAGE` | no | yes | yes | assigned sites / all sites |
| `SITE_LOGS_MANAGE` | no | yes | yes | assigned sites / all sites |
| `USER_ROLE_MANAGE` | no | no | yes | global |
| `USER_DELETE` | no | no | yes | global |
| `SYSTEM_PRESET_MANAGE` (deployment template presets) | no | no | yes | global |
| `INSTALLER_MANAGE` | no | no | yes | global |
| `GLOBAL_SETTINGS_WRITE` | no | no | yes | global |

Cortex chat access follows site read access. Cortex actions that execute commands or write machine configuration require `MACHINE_EXEC_COMMAND` or `MACHINE_CONFIG_WRITE`. Site-level LLM keys are API-backed global settings; no separate Admin Panel tab is documented here.
