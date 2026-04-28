# installer management

Upload, manage, and distribute agent installer versions.

**Location**: Admin Panel -> Installer Versions (`/admin/installers`)

The dashboard uses the same canonical `/api/installer/*` public management API as the CLI and SDKs. All actions require a superadmin session.

---

## uploading a new version

1. Click **Upload New Version**.
2. Select the `.exe` installer.
3. Enter a version in `X.Y.Z` format.
4. Add release notes if needed.
5. Choose whether to set the version as latest.
6. Click **Upload Installer** and wait for progress to complete.

The browser requests a signed upload URL, uploads the file directly to Storage, computes SHA-256, then finalizes through `PUT /api/installer/upload`. The server recomputes SHA-256 from the stored object and rejects mismatches with `checksum_mismatch`.

---

## version table

Each active version shows:

| column | description |
|--------|-------------|
| **Version** | Version number |
| **File Size** | Installer file size |
| **Release Date** | Upload date |
| **Release Notes** | Change description |
| **Uploaded By** | User who uploaded it |
| **Status** | Latest badge if current |

Soft-deleted versions are hidden from the dashboard list.

---

## actions

### set as latest

Promotes an uploaded, active version through `POST /api/installer/{version}/set-latest`. Use this for rollback if a newer installer has issues.

### download

Downloads use the signed `download_url` returned by the installer API.

### delete

Delete soft-deletes the version through `DELETE /api/installer/{version}`. It does not remove the Storage object during the interactive action.

You cannot delete:

- the current latest version (`latest_version_protected`)
- a version when doing so would leave fewer than two active versions (`min_versions_violated`)

---

## cleanup

The **Clean Up** action identifies superseded patch versions:

- not the newest patch in its `major.minor` series
- older than the retention window
- not the current latest version

Each candidate is soft-deleted via the public API.

---

## public download button

All users see a dashboard download button that points to the current latest installer. The unauthenticated permalink remains `GET /download`; admin management metadata comes from `GET /api/installer/latest`.

---

## storage

Installers are stored under:

```text
agent-installers/versions/{version}/Owlette-Installer-v{version}.exe
```

Metadata is stored in Firestore under:

```text
installer_metadata/latest
installer_metadata/data/versions/
installer_uploads/{uploadId}
```
