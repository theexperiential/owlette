# installer management

Upload, manage, and distribute agent installer versions.

**Location**: Admin Panel → Installer Versions (`/admin/installers`)

---

## uploading a new version

1. Click **"Upload New Version"**
2. **Upload file**: Drag & drop or browse for the `.exe` installer
3. **Version number**: Enter version in `X.Y.Z` format (e.g., `2.1.8`)
4. **Release notes** (optional): Describe what changed
5. **Set as latest**: Check to make this the default download version
6. Click **"Upload Installer"**
7. Watch the upload progress bar
8. Version appears in the table immediately

### requirements

- File must be `.exe` format
- Version format: `X.Y.Z` (semantic versioning)
- File is renamed to `Owlette-Installer-v{version}.exe` in Firebase Storage
- SHA-256 checksum is computed automatically

---

## version table

Each version shows:

| column | description |
|--------|-------------|
| **Version** | Version number (e.g., 2.1.8) |
| **File Size** | Installer file size |
| **Release Date** | When it was uploaded |
| **Release Notes** | Change description |
| **Uploaded By** | Admin who uploaded it |
| **Status** | "Latest" badge if current |

---

## actions

### set as latest

1. Find the version in the table
2. Click **"Set as Latest"**
3. The download button in the dashboard header immediately updates for all users

Use this for **rollback** — if the latest version has issues, set an older version as latest.

### download

Click the download icon next to any version to download it directly from Firebase Storage.

### delete

1. Click the trash icon next to a version
2. Confirm deletion

!!! warning
    You cannot delete the version currently set as "latest". Set a different version as latest first, then delete the old one.

---

## public download button

All users (including non-admins) see a **download button** in the dashboard header:

- Always points to the "latest" version
- Shows version number on hover
- Opens in a new tab for direct download
- Updates in real-time when admins change the latest version

---

## storage

Installers are stored in Firebase Storage under:

```
installers/Owlette-Installer-v{version}.exe
```

Metadata is stored in Firestore under:

```
installer_metadata/latest          — Current latest version info
installer_metadata/data/versions/  — All version records
```
