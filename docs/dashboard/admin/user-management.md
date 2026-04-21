# user management

Manage user accounts, roles, and site assignments from the Admin Panel. Only superadmins can open this page.

**Location**: Admin Panel → User Management (`/admin/users`)

---

## the three-role model

| role | platform access | site access |
|------|-----------------|-------------|
| **member** | none | read-only on assigned sites |
| **admin** | none | write access (reboot / delete machines, edit display layouts, site settings) on assigned sites |
| **superadmin** | full Admin Panel | implicit access to every site |

New users start as `member` by default. Superadmins promote to `admin` (site-scoped operator) or `superadmin` (platform administrator) from this page.

---

## user list

The user management page shows all registered users with:

| column | description |
|--------|-------------|
| **Email** | User's email address |
| **Display Name** | Full name (if provided during registration) |
| **Role** | `member`, `admin`, or `superadmin` — colour-coded badge |
| **Sites** | For members: number of assigned sites. For admins: pill list of each assigned site. For superadmins: "all sites (via superadmin)". |
| **Joined** | Registration date |

### statistics

The page header shows four cards:

- **Total Users** — All registered accounts
- **Superadmins** — Users with platform-wide god-mode (red Crown icon)
- **Admins** — Site-scoped operators (green ShieldAlert icon)
- **Members** — Read-only users on their assigned sites

---

## changing a user's role

1. Find the user in the list
2. Click the **⋮** menu on their row → **"Change role..."**
3. In the dialog, pick one of the three roles from the dropdown. Each option shows an icon + one-line description of what that role can do.
4. Click **Save**. The badge flips and the stats-card counts update immediately.

!!! note "Save-disabled-on-noop"
    The save button is disabled when the selected role matches the current role, so accidental re-saves are impossible.

### self-demotion

The change-role menu item is **disabled on your own row if you're a superadmin** — demoting the last superadmin would lock everyone out of the Admin Panel. To step down, first promote another superadmin, then have them demote you.

Admins and members can demote themselves freely since neither tier grants cross-site powers that an unassigned admin could abuse after self-demotion.

!!! note "Session refresh"
    Users must log out and log back in (or wait for their session to refresh) to see role changes reflected in their own UI.

---

## site assignment

Control which sites a user can access. Applies to both `member` and `admin` roles — `admin` gets elevated powers only on sites listed in their `sites` array. Superadmins ignore site assignments (god-mode).

### assign a site

1. Find the user in the list
2. Click **"Manage Sites"**
3. View currently assigned sites and available sites
4. Click **"Assign"** next to an available site
5. The user can now access that site's machines and data (with member or admin capabilities depending on their role)

### remove a site

1. Click **"Manage Sites"** for the user
2. Click the **X** icon next to an assigned site
3. The user loses access to that site immediately

### access rules

| role | site access |
|------|-------------|
| **Member** | Read-only on sites in their `sites` array |
| **Admin** | Read + elevated writes on sites in their `sites` array |
| **Superadmin** | All sites, regardless of assignment |
| **Agent** | Single site (from OAuth token claims) |

---

## best practices

- **Principle of least privilege** — Most users should be `member`. Promote to `admin` when they need to operate a specific site's machines. Reserve `superadmin` for platform administrators who manage users, installers, and cross-site settings.
- **Audit superadmins regularly** — Review who has platform-wide access periodically; this is the only role that can read every site's data and promote other users.
- **Site-based organization** — Assign users to sites matching their responsibility (e.g., NYC office staff only see NYC machines). Pair site assignment with the right role tier.
- **Redundancy** — Keep at least 2 superadmin accounts to prevent lockout. If only one superadmin exists and they leave, you'll need Firebase Console access to promote a replacement manually.
