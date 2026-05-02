# Owlette Scripts

Utility scripts for managing the Owlette monorepo.

## Version Sync

Keep component versions synchronized across the monorepo.

### Usage

**Check current versions:**
```bash
node sync-versions.js
# or
python sync_versions.py
```

**Output:**
```
📦 Current Versions:

  Product:  2.0.4
  Agent:    2.0.4
  Web:      2.0.4

  Note: Firestore rules version is independent (tracks schema changes)
```

**Bump to new version:**
```bash
node sync-versions.js 2.1.0
# or
python sync_versions.py 2.1.0
```

This updates:
- `/VERSION` - Product release version
- `agent/VERSION` - Agent binary version
- `web/package.json` - Web app version

**The script will remind you to:**
1. Update docs/changelog.md with release notes
2. Commit changes: `git commit -am "chore: Bump version to X.Y.Z"`
3. Create tag: `git tag vX.Y.Z`
4. Push with tags: `git push origin main --tags`

### Files Updated

| File | Component | Read By |
|------|-----------|---------|
| `/VERSION` | Product release | Documentation, releases |
| `agent/VERSION` | Agent binary | `agent/src/shared_utils.py` |
| `web/package.json` | Web app | npm, Next.js build |

### Firestore Rules Version

**NOT** automatically updated by this script.

Firestore rules track security schema changes independently:
- Current: 2.2.0 - Multi-User Site Access Control
- Update manually in `firestore.rules` header
- Only bump when authentication model or data structure changes

### Examples

**Normal release (sync all components):**
```bash
node sync-versions.js 2.1.0
# Update docs/changelog.md
git add VERSION agent/VERSION web/package.json docs/changelog.md
git commit -m "chore: Bump version to 2.1.0"
git tag v2.1.0
git push origin main --tags
```

**Pre-release version:**
```bash
node sync-versions.js 2.1.0-rc.1
```

**Check versions only:**
```bash
node sync-versions.js
```

## Role Migration

One-off data migration for the two-role → three-role permission model split. See [dev/active/permission-model-split/plan.md](../dev/active/permission-model-split/plan.md) for context.

### Usage

```bash
# Preview changes against dev (read-only)
node scripts/migrate-roles.mjs --env=dev --dry-run

# Apply to dev
node scripts/migrate-roles.mjs --env=dev

# Preview against prod (prompts for confirmation on live runs)
node scripts/migrate-roles.mjs --env=prod --dry-run
```

Flips `role: 'user'` → `'member'` and `role: 'admin'` → `'superadmin'` on the `users` collection. Idempotent — re-running after migration is a no-op because the three terminal values (`member`/`admin`/`superadmin`) are left untouched.

### Credentials

Reads `FIREBASE_PROJECT_ID_{DEV|PROD}`, `FIREBASE_CLIENT_EMAIL_{DEV|PROD}`, `FIREBASE_PRIVATE_KEY_{DEV|PROD}` from the environment. Falls back to the unsuffixed `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` (web/.env.local vars) with a warning — verify those point at the intended project before live runs.

Auto-loads `web/.env.local`, `.claude/.env.local`, and `scripts/.env.local` (in that order; later files don't override earlier values).

### Deploy order

Run migration **before** pushing the updated `firestore.rules`. Reverse order would transiently lock existing admins out of their sites during the window between the rules deploy and the data migration.

## Related Documentation

- [docs/version-management.md](../docs/version-management.md) - Complete version management guide
- [.claude/CLAUDE.md](../.claude/CLAUDE.md#version-management) - Developer workflow
- [docs/changelog.md](../docs/changelog.md) - Release history

---

**Last Updated:** 2026-04-19
