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
| `isSuperadmin()` | User document has `role: "superadmin"` |
| `isServiceAccount()` | Request token has `admin: true`; Firebase Admin SDK calls bypass rules entirely |
| `isAgent()` | Token has `role: "agent"`, `site_id`, and `machine_id` claims |
| `isSiteOwner(siteId)` | Site document `owner` matches the authenticated user id |
| `agentCanAccessSite(siteId)` | Agent token `site_id` matches `siteId` |
| `agentCanAccessMachine(siteId, machineId)` | Agent token matches both `site_id` and `machine_id` |
| `canAccessSite(siteId)` | User owns the site, is a superadmin, or has `siteId` in their user document `sites[]` array |
| `isSiteAdmin(siteId)` | User has `role: "admin"` or `"superadmin"` and passes `canAccessSite(siteId)` |
| `hasRequiredFields(required)` | Write payload contains all required field names |

### access matrix

These are Firestore client-rule permissions. Trusted server routes that use the Firebase Admin SDK bypass these rules; paths marked "server/Admin SDK only" are denied to ordinary client SDK writes and must be managed by server code.

| path | member/admin client | superadmin client | agent client | trusted server / Admin SDK |
|------|---------------------|-------------------|--------------|----------------------------|
| `sites/{siteId}` | Read owned or assigned sites; no direct write | Read all sites; no direct write | No access | Create/update/delete |
| `sites/{siteId}/machines/{machineId}` | Read machines in accessible sites; no direct write | Read all machines; no direct write | Read/write/delete own machine only | Full write |
| `sites/{siteId}/machines/{machineId}/commands/{commandDoc}` | Read commands in accessible sites; no direct write | Read all commands; no direct write | Read/write/delete own machine commands | Full write |
| `sites/{siteId}/machines/{machineId}/screenshots/{screenshotId}` | Read screenshots in accessible sites | Read all screenshots | No access | Write history entries |
| `sites/{siteId}/machines/{machineId}/installed_software/{softwareId}` | Read and delete inventory in accessible sites | Read and delete inventory in all sites | Read/write/delete own machine inventory | Full write |
| `sites/{siteId}/machines/{machineId}/hardware/{docId}` | Read hardware in accessible sites; no direct write | Read all hardware; no direct write | Read/write/delete own machine hardware | Full write |
| `sites/{siteId}/machines/{machineId}/metrics_history/{bucketId}` | Read metrics in accessible sites; no direct write | Read all metrics; no direct write | Read/write/delete own machine metrics | Full write |
| `sites/{siteId}/deployments/{deploymentId}` | Read deployments in accessible sites; no direct write | Read all deployments; no direct write | No access | Create/update/delete |
| `sites/{siteId}/installer_templates/{templateId}` | Read templates in accessible sites; no direct write | Read all templates; no direct write | No access | Create/update/delete |
| `sites/{siteId}/project_templates/{templateId}` | Read templates in accessible sites; no direct write | Read all templates; no direct write | No access | Create/update/delete |
| `sites/{siteId}/project_distributions/{distributionId}` | Read legacy distributions in accessible sites; no direct write | Read all legacy distributions; no direct write | No access | Create/update/delete |
| `sites/{siteId}/roosts/{roostId}` | Read/create/update/delete roost shells in accessible sites; client creates cannot set version pointers and client updates cannot change version pointers or `schemaVersion` | Same for all sites | No access | Publish/rollback version pointer changes |
| `sites/{siteId}/roosts/{roostId}/target_state/{machineId}` | Read/delete target state in accessible sites; no direct create/update | Read/delete all target state; no direct create/update | Create/update own machine target state | Full write |
| `sites/{siteId}/roosts/{roostId}/versions/{versionId}` | Read version history in accessible sites; no direct write | Read all version history; no direct write | No access | Server/Admin SDK only |
| `sites/{siteId}/webhooks/{webhookId}` | Read webhooks in accessible sites; no direct write | Read all webhooks; no direct write | No access | Write |
| `sites/{siteId}/logs/{logId}` | Read logs in accessible sites; no direct write | Read all logs; no direct write | Read site logs and create own-machine log entries | Create/delete |
| `sites/{siteId}/audit_log/{entryId}` | Site admins can read; members cannot read | Read all audit entries | No access | Server/Admin SDK only |
| `sites/{siteId}/settings/{settingId}` | Read settings in accessible sites; no direct write | Read all settings; no direct write | No access | Write |
| `config/{siteId}/machines/{machineId}` | Read machine config in accessible sites; no direct write | Read all machine config; no direct write | Read/write/delete own machine config | Full write |
| `config/{siteId}/schedule_presets/{presetId}` | Read presets in accessible sites; no direct write | Read all presets; no direct write | No access | Write/delete |
| `config/{siteId}/reboot_presets/{presetId}` | Read presets in accessible sites; no direct write | Read all presets; no direct write | No access | Write/delete |
| `config/{siteId}/project_distribution_presets/{presetId}` | Read presets in accessible sites; no direct write | Read all presets; no direct write | No access | Write/delete |
| `users/{userId}` | Read own profile, self-create as `member`, and update allowed self fields without changing `role`, `email`, or `sites` | Read all user profiles; role/site writes still server-mediated | No access | Manage roles, site assignments, and deletion |
| `users/{userId}/settings/{settingId}` | Read/write own settings only | Read/write own settings only | No access | Admin SDK bypass only |
| `users/{userId}/devicePrefs/{docId}` | Read/write own device preferences only | Read/write own device preferences only | No access | Admin SDK bypass only |
| `users/{userId}/api_keys/{keyId}` | Read own API key inventory; no direct write | Read own API key inventory only; no direct write | No access | Server/Admin SDK only |
| `installer_metadata/{document=**}` | Public read | Public read | Public read | Write |
| `system_presets/{presetId}` | Read if authenticated; no direct write | Read if authenticated; no direct write | Read if authenticated; no direct write | Create/update/delete |
| `chats/{chatId}` and `chats/{chatId}/messages/{messageId}` | Create own or autonomous chats; read/write own chats and messages; read autonomous chats for accessible sites | Same, plus read autonomous chats for all sites | No site-scoped reads; generic authenticated create/owner rules still apply | Admin SDK bypass only |
| `agent_tokens/{tokenId}` | No access | No access | No access | Server/Admin SDK only |
| `agent_refresh_tokens/{tokenHash}` | No access | No access | No access | Server/Admin SDK only |
| `device_codes/{phrase}` | No access | No access | No access | Server/Admin SDK only |
| `api_keys/{keyHash}` | No access | No access | No access | Server/Admin SDK only |
| any unmatched path | No access | No access | No access | Admin SDK bypass only |

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

Rules enforce **strict machine isolation** for machine-scoped agent writes. An agent can write only its own machine documents, config, command documents, inventory, hardware, metrics, logs, and roost target state. Agents can also read their own machine state, site logs, and authenticated system presets where the matrix above allows it.

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
