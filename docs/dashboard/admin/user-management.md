# user management

Manage user accounts, roles, and site assignments from the Admin Panel.

**Location**: Admin Panel → User Management (`/admin/users`)

---

## user list

The user management page shows all registered users with:

| Column | Description |
|--------|-------------|
| **Email** | User's email address |
| **Display Name** | Full name (if provided during registration) |
| **Role** | `user` or `admin` |
| **Sites** | Number of assigned sites |
| **Joined** | Registration date |

### statistics

The page header shows:

- **Total Users** — All registered accounts
- **Admins** — Users with admin role
- **Regular Users** — Non-admin users

---

## promoting / demoting users

### promote to admin

1. Find the user in the list
2. Click **"Promote to Admin"**
3. Confirm the action
4. User immediately gains admin privileges

### demote to user

1. Find the admin user in the list
2. Click **"Demote to User"**
3. Confirm the action
4. User loses admin privileges immediately

!!! warning "Self-demotion"
    You cannot demote yourself — this prevents accidentally locking all admins out.

!!! note
    Users must log out and log back in to see role changes reflected in their UI.

---

## site assignment

Control which sites a user can access.

### assign a site

1. Find the user in the list
2. Click **"Manage Sites"**
3. View currently assigned sites and available sites
4. Click **"Assign"** next to an available site
5. The user can now access that site's machines and data

### remove a site

1. Click **"Manage Sites"** for the user
2. Click the **X** icon next to an assigned site
3. The user loses access to that site immediately

### access rules

| Role | Site Access |
|------|-------------|
| **User** | Only sites in their `sites` array |
| **Admin** | All sites (regardless of assignment) |
| **Agent** | Single site (from OAuth token claims) |

---

## best practices

- **Principle of least privilege** — Only grant admin to users who need it
- **Audit regularly** — Review who has admin access periodically
- **Site-based organization** — Assign users to sites matching their responsibility (e.g., NYC office staff only see NYC machines)
- **Redundancy** — Keep at least 2 admin accounts to prevent lockout
