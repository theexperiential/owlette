# Project Distribution

Distribute project files (ZIP archives) across your machines using your own file hosting. owlette handles the download, extraction, and verification — you just provide the URL.

---

## How It Works

```
Your File Host              owlette Cloud              Agent Machines
(Dropbox/Drive/etc.)       (Firestore)               (Windows)
────────────────────────────────────────────────────────────────────

1. Upload ZIP to host

2. Create distribution ──────▶ Store metadata
   in dashboard                (no file upload!)

3. Send commands ────────────▶ Commands queued

4.                                              Download ZIP
   ◀─────────────────────────                  directly from host
   (not through owlette!)                       Report progress ──▶

5.                                              Extract to path
                                                Report progress ──▶

6.                                              Verify files
                                                Report complete ──▶
```

**Key point**: Files download directly from your host to the machines — owlette never stores or proxies the files. This keeps costs near zero.

---

## Creating a Distribution

1. Navigate to **Projects** from the dashboard menu
2. Click **"New Distribution"**
3. Fill in the configuration:

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | Descriptive name (e.g., "Summer Show 2024") |
| **Project URL** | Yes | Direct download link to ZIP file |
| **Extract To** | No | Custom path (default: `~/Documents/OwletteProjects`) |
| **Verify Files** | No | Comma-separated file/folder names to check after extraction |
| **Save as Template** | No | Save configuration for reuse |

4. Select target machines
5. Click **"Distribute to N Machines"**

---

## File Hosting Options

| Host | Free Storage | Direct Download URL |
|------|-------------|-------------------|
| **Dropbox** | 2 GB | Change `?dl=0` to `?dl=1` in share link |
| **Google Drive** | 15 GB | `https://drive.google.com/uc?export=download&id=FILE_ID` |
| **Backblaze B2** | 10 GB | `https://f002.backblazeb2.com/file/bucket/file.zip` |
| **Your Server** | Varies | Any direct download URL |

!!! tip "Best for large files"
    Backblaze B2 is the cheapest option for large files: $0.005/GB storage with free egress (up to 3x your storage).

### Cost Comparison (100 GB project to 10 machines)

| Host | Storage | Bandwidth | Total/Month |
|------|---------|-----------|-------------|
| Dropbox | $11.99 (2TB plan) | Included | **$11.99** |
| Google Drive | $9.99 (2TB plan) | Included | **$9.99** |
| Backblaze B2 | $0.50 | Free (3x rule) | **$0.50** |

owlette infrastructure cost: **~$0.001** per distribution (Firestore operations only).

---

## Distribution Progress

Real-time status per machine:

| Status | Description |
|--------|-------------|
| **Downloading** | Downloading ZIP (shows percentage) |
| **Extracting** | Extracting files (shows percentage) |
| **Completed** | All files extracted and verified |
| **Failed** | Download, extraction, or verification failed |

---

## File Verification

Specify files to check after extraction:

```
Verify Files: MyProject.toe, Assets/video1.mp4, config.json
```

The agent checks that each file or folder exists relative to the extraction path. If any are missing, the distribution reports a warning but still marks as completed.

---

## Templates

Save distribution configurations for reuse:

1. Check **"Save as template"** when creating a distribution
2. Templates store: name, URL, extract path, verify files
3. Load from the dropdown when creating future distributions
4. Edit or delete templates as needed

Useful for recurring content updates (e.g., monthly signage content).

---

## Examples

### TouchDesigner Project

```
Name: Art Installation - March 2026
URL: https://www.dropbox.com/s/abc123/ArtInstall.zip?dl=1
Extract To: C:\TouchDesigner\Projects
Verify: ArtInstall.toe, Assets/videos/, config.json
```

### Digital Signage Content

```
Name: March Signage Content
URL: https://f002.backblazeb2.com/file/my-bucket/signage-march.zip
Extract To: (default)
Verify: videos/promo1.mp4, images/background.png
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Download failed | Bad URL or no internet | Test URL in browser; verify it directly downloads |
| Extraction failed | Corrupt ZIP or no disk space | Re-upload ZIP; check disk space |
| Files missing after extraction | Wrong verify paths | Check ZIP structure; paths are relative to extract location |
| Slow download | Large file or slow host | Use CDN-backed hosting; schedule off-peak |
