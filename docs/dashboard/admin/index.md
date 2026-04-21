# admin panel

The Admin Panel provides management tools for users, agent installers, system presets, schedule presets, tokens, alerts, webhooks, and email settings. Only users with the **superadmin** role can access these platform-wide features. Site-scoped admin capabilities (managing machines, display layouts, site settings on assigned sites) live on the site dashboard and are available to both `admin` and `superadmin` roles.

---

## roles at a glance

Owlette uses a three-tier role model:

| role | platform access | site access |
|------|-----------------|-------------|
| **member** | none | read-only on assigned sites |
| **admin** | none | write access on assigned sites (reboot, delete machines, edit display layouts, site settings) |
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

| capability | member | admin | superadmin |
|-----------|:------:|:-----:|:----------:|
| View assigned sites | ✅ | ✅ | ✅ (all sites) |
| Monitor machines on assigned sites | ✅ | ✅ | ✅ |
| Reboot / shutdown a machine | ⛔ | ✅ (assigned sites only) | ✅ |
| Delete a machine | ⛔ | ✅ (assigned sites only) | ✅ |
| Edit display layouts (store / recall / clear) | ⛔ | ✅ (assigned sites only) | ✅ |
| Configure site webhooks / settings | ⛔ | ✅ (assigned sites only) | ✅ |
| Create deployments | ✅ | ✅ | ✅ |
| Create distributions (roost) | ✅ | ✅ | ✅ |
| Use Cortex | ✅ | ✅ | ✅ |
| View activity logs | ✅ | ✅ | ✅ |
| **Manage users** | ⛔ | ⛔ | **✅** |
| **Upload installers** | ⛔ | ⛔ | **✅** |
| **Manage system presets** | ⛔ | ⛔ | **✅** |
| **Manage agent tokens** | ⛔ | ⛔ | **✅** |
| **Manage schedule presets** | ⛔ | ⛔ | **✅** |
| **Configure threshold alerts** | ⛔ | ⛔ | **✅** |
| **Configure webhooks (cross-site)** | ⛔ | ⛔ | **✅** |
| **Send test emails** | ⛔ | ⛔ | **✅** |
| **Set site-level LLM keys** | ⛔ | ⛔ | **✅** |
| **Simulate events** | ⛔ | ⛔ | **✅** |

