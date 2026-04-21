# firestore security rules

Firestore security rules control who can read and write data. owlette's rules enforce site-scoped access, agent isolation, and role-based permissions.

---

## deployment methods

### method 1: firebase cli (recommended)

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login and select project
firebase login
firebase use --add

# Deploy rules
firebase deploy --only firestore:rules
```

Expected output:

```
✔ firestore: rules file firestore.rules compiled successfully
✔ firestore: released rules firestore.rules to cloud.firestore
✔ Deploy complete!
```

### method 2: firebase console

1. Go to Firebase Console → Firestore Database → **Rules** tab
2. Copy contents of `firestore.rules` from the repository
3. Paste into the editor
4. Click **"Validate"** (should show green checkmark)
5. Click **"Publish"**
6. Rules are live within ~30 seconds

!!! tip "Source of truth"
    The `firestore.rules` file in the repository is the canonical version. Always deploy from the file to keep version control synchronized.

---

## rule architecture

### key functions

| function | purpose |
|----------|---------|
| `isAuthenticated()` | User has a valid Firebase Auth token |
| `isSuperadmin()` | User's `role` is `"superadmin"` — platform god-mode |
| `isSiteAdmin(siteId)` | User's `role` is `"admin"` or `"superadmin"` AND the site is accessible (assigned via `sites[]` for admins, implicit for superadmins) |
| `canAccessSite(siteId)` | User is superadmin, site owner, or has `siteId` in their `sites[]` array |
| `isAdmin()` | **Deprecated alias for `isSuperadmin()`** — kept for backwards compatibility during the 2.9.0 → 2.10.0 rollout window; removed in a future release. Do not use in new rules. |
| `isAgent()` | Token has `role: "agent"` claim |
| `agentCanAccessSite(siteId)` | Agent's `site_id` claim matches |
| `agentCanAccessMachine(siteId, machineId)` | Agent's claims match both site and machine |

### access matrix

| collection | member | admin | superadmin | agent |
|-----------|:------:|:-----:|:----------:|:-----:|
| `sites/{siteId}` read | Read if site in `sites[]` | Read if site in `sites[]` | Read all | Read own site |
| `sites/{siteId}/machines/**` | Read if site in `sites[]` | Read/Write if site in `sites[]` | Read/Write all | Read/Write own machine only |
| `sites/{siteId}/settings/**` | Read if site in `sites[]` | Read/Write if site in `sites[]` (gated by `isSiteAdmin(siteId)`) | Read/Write all | — |
| `sites/{siteId}/webhooks/**` | Read if site in `sites[]` | Read/Write if site in `sites[]` (gated by `isSiteAdmin(siteId)`) | Read/Write all | — |
| `users/{userId}` | Read/Write own doc | Read/Write own doc | Read/Write any user (gated by `isSuperadmin()`) | No access |
| `installer_metadata/**` | Read public (version list only) | Read public | Read/Write all (gated by `isSuperadmin()`) | Read public |
| `system_presets/**` | Read | Read | Read/Write (gated by `isSuperadmin()`) | — |

Members and admins differ only on **write scope for site-scoped collections** (`machines`, `settings`, `webhooks`). Admins get writes on their assigned sites; members do not. Neither tier has any platform-wide powers — those are exclusive to `superadmin`.
| `agent_tokens/**` | No access | No access | No access (server-only) |
| `agent_refresh_tokens/**` | No access | No access | No access (server-only) |
| `installer_metadata/**` | Read | Read/Write | No access |
| `activity_logs/**` | Read if site access | Read/Write | Write own machine |

---

## agent authentication

Agents use **custom Firebase tokens** with claims:

```json
{
  "role": "agent",
  "site_id": "nyc-office",
  "machine_id": "DESKTOP-ABC123"
}
```

Rules enforce **strict machine isolation** — an agent can only read/write documents for its own machine within its own site. It cannot access other machines, even within the same site.

---

## testing rules

### rules playground

1. Firebase Console → Firestore → Rules → **Playground**
2. Set the document path to test
3. Configure authentication (user, admin, or agent claims)
4. Test read/write operations

### example tests

**Agent accessing own machine (should allow):**

- Path: `sites/site_abc/machines/DESKTOP-001`
- Auth: Custom claims `{role: "agent", site_id: "site_abc", machine_id: "DESKTOP-001"}`
- Operation: GET → Should be **allowed**

**Agent accessing different machine (should deny):**

- Same as above but `machine_id: "DESKTOP-002"`
- Operation: GET → Should be **denied**

**Token collection access (should deny everyone):**

- Path: `agent_tokens/test_code`
- Auth: Any (even admin)
- Operation: GET → Should be **denied**

---

## rollback

If rules cause issues:

### via firebase console

1. Firestore → Rules → Click **"History"** (clock icon)
2. Find previous version → Click **"Restore"**

### via git

```bash
git checkout HEAD~1 firestore.rules
firebase deploy --only firestore:rules
```

---

## versioning

Firestore rules version is managed independently from the product version. The rules version is tracked inside the `firestore.rules` file header comment.

---

## monitoring

- **Firebase Console → Firestore → Usage**: Monitor denied reads/writes
- Spike in denials after a rule change = something broke
- **Agent logs**: Look for "Permission denied" or "HTTP error 403"
- **Browser console**: Look for "Missing or insufficient permissions"
