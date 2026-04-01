# Workstream 3: Screenshot Capture

**Priority:** 3 | **Effort:** Medium | **Round:** 3 (independent) | **Branch:** `dev`

## Goal
Capture a screenshot on a remote machine via dashboard command and display it in a modal. Critical for digital signage and kiosk operators who need visual confirmation that content is displaying correctly.

## Status
- [x] Agent: `capture_screenshot` command handler
- [x] Agent: IPC to GUI for user-session screenshot capture
- [x] Agent: Add `mss` to requirements.txt
- [x] Web API: `/api/agent/screenshot/route.ts` upload endpoint
- [x] Web UI: `ScreenshotDialog.tsx` modal component
- [x] Web UI: Screenshot button on machine context menu
- [x] Storage: Firebase Storage — uploads to `screenshots/{siteId}/{machineId}/latest.jpg`, URL in Firestore
- [x] Testing: Multi-monitor screenshot (4080x3840 → 3840px resize → JPEG q80 → Storage)
- [ ] Testing: Headless machine error handling
- [ ] Testing: Storage cleanup / retention

## Context

### Critical Windows Challenge: Session 0 Isolation
The Owlette agent runs as a Windows service (NSSM) in **Session 0**, which has NO access to the desktop. The GUI (`owlette_gui.py`) runs in the user's session and CAN access the desktop.

**Solution:** Use the existing IPC mechanism between the service and GUI. The service sends a screenshot request to the GUI, the GUI captures and returns it.

### What Already Exists
- **Command system:** `owlette_service.py` has a command handler pattern (`_handle_restart_process`, `_handle_kill_process`, etc.) in the `_process_command()` method
- **IPC mechanism:** Check if there's existing IPC between service and GUI (pipe, socket, or shared file). If not, establish one.
- **GUI process:** `owlette_gui.py` runs as `pythonw.exe` in the user session with desktop access
- **Firebase client:** `firebase_client.py` handles all Firestore REST API operations
- **Agent auth:** Bearer token auth for agent-to-web API calls

### Files to Create
| File | Purpose |
|------|---------|
| `web/app/api/agent/screenshot/route.ts` | Receive screenshot uploads from agent |
| `web/components/ScreenshotDialog.tsx` | Modal to view/request screenshots |

### Files to Modify
| File | Change |
|------|--------|
| `agent/src/owlette_service.py` | Add `_handle_capture_screenshot()` command handler |
| `agent/src/owlette_gui.py` | Add screenshot capture capability (responds to IPC request) |
| `agent/requirements.txt` | Add `mss` library |
| `web/components/MachineCard.tsx` | Add screenshot button |

### Implementation Details

**Agent Service Side (`owlette_service.py`):**
```python
def _handle_capture_screenshot(self, command_data):
    """Handle screenshot capture command."""
    try:
        # Option A: IPC to GUI
        # Send request to GUI via shared file or named pipe
        # GUI captures screenshot and saves to temp path
        # Service reads temp file and uploads

        # Option B: Direct capture (if running in user session for debug mode)
        import mss
        with mss.mss() as sct:
            # Capture all monitors
            screenshot = sct.grab(sct.monitors[0])  # monitors[0] = all monitors combined

            # Convert to JPEG bytes
            from PIL import Image
            import io
            img = Image.frombytes('RGB', screenshot.size, screenshot.bgra, 'raw', 'BGRX')
            buffer = io.BytesIO()
            img.save(buffer, format='JPEG', quality=70)
            jpeg_bytes = buffer.getvalue()

        # Upload to web API
        self._upload_screenshot(jpeg_bytes)

        return {'status': 'completed', 'message': 'Screenshot captured'}
    except Exception as e:
        return {'status': 'failed', 'message': f'Screenshot failed: {str(e)}'}
```

**GUI Side (`owlette_gui.py`) — IPC Screenshot Handler:**
The GUI needs to be able to receive a screenshot request and respond. Options:
1. **Named pipe** — service writes to `\\.\pipe\owlette_screenshot`, GUI listens and responds
2. **Shared file** — service writes `screenshot_request.json` to ProgramData, GUI watches and writes `screenshot_response.jpg`
3. **Local HTTP** — GUI runs a tiny HTTP server on localhost, service POSTs to it

**Recommendation: Shared file approach** (simplest, no new dependencies):
- Service writes `C:\ProgramData\Owlette\ipc\screenshot_request.json` with `{ "requestId": "uuid", "timestamp": "..." }`
- GUI watches for this file (in its existing event loop), captures screenshot, saves to `C:\ProgramData\Owlette\ipc\screenshot_{requestId}.jpg`
- Service polls for response file (timeout 10 seconds)
- Service reads JPEG, deletes both IPC files, uploads to web API

**Web API (`/api/agent/screenshot/route.ts`):**
```typescript
// POST /api/agent/screenshot
// Auth: Bearer token (agent Firebase ID token)
// Body: multipart/form-data with JPEG file, or JSON with base64
// Response: { success: true, url: string }

export async function POST(request: Request) {
  // 1. Verify agent auth (same as /api/agent/alert)
  // 2. Extract screenshot data
  // 3. Store in Firestore (base64) or Firebase Storage
  // 4. Write screenshot reference to machine document
  //    sites/{siteId}/machines/{machineId} → lastScreenshot: { url, timestamp }
  // 5. Return success
}
```

**Storage Decision:**
- **Firestore base64 (v1, simpler):** Store as base64 string in `sites/{siteId}/machines/{machineId}` document under `lastScreenshot.data` field. Firestore 1MB doc limit fits a compressed 1080p screenshot (~200KB). Only store latest screenshot (overwrite on each capture).
- **Firebase Storage (v2, better):** Upload to Storage bucket with 24h lifecycle. Better for multi-monitor/high-res but requires Storage setup and agent Storage auth.
- **Start with Firestore base64** — it's simpler and doesn't require new infrastructure. Migrate to Storage later if needed.

**Web UI (`ScreenshotDialog.tsx`):**
```
- Trigger: "Screenshot" button/icon on MachineCard (camera icon from lucide-react)
- On click:
  1. Write command to Firestore: sites/{siteId}/machines/{machineId}/commands/pending/{id}
     { type: 'capture_screenshot', createdAt: now, createdBy: userId }
  2. Show loading state: "Capturing screenshot..."
  3. Listen for command completion in commands/completed
  4. On completion, read lastScreenshot from machine document
  5. Display in modal: JPEG image, timestamp, "Refresh" button
- Show last screenshot timestamp: "Last captured: 2 minutes ago"
- Error state: "Screenshot failed — machine may be running headless"
```

### Key Considerations
- **Session 0 isolation is the biggest challenge.** The service cannot access the desktop. The GUI must be the capture agent. If the GUI is not running, screenshot should fail gracefully with a clear error message.
- **Compress aggressively:** JPEG quality 70 → ~200KB for 1080p. This fits in Firestore's 1MB doc limit.
- **Only store the latest screenshot** per machine (overwrite). No history. This keeps storage minimal.
- **Multi-monitor:** `mss.monitors[0]` captures all monitors stitched together. This is the right default for digital signage setups.
- **Security:** Screenshots can show sensitive content. Only admins should be able to request screenshots. Add a small note in the UI: "Screenshots may contain sensitive content."
- **Timeout:** If no screenshot is received within 15 seconds of command, show timeout error.
- **mss library:** Pure Python, no system dependencies, ~50KB installed. Cross-platform but we only need Windows. Add to `requirements.txt`.
- **Pillow dependency:** Already available? Check agent's requirements.txt. If not, `mss` can save to PNG natively without Pillow, but JPEG compression requires Pillow. If Pillow isn't available, save as PNG (larger but no new dependency).

### Testing Plan
1. Request screenshot from dashboard → verify image appears in modal within 10 seconds
2. Test with 2+ monitors → verify all monitors captured in one image
3. Stop the GUI process → request screenshot → verify graceful error ("GUI not running")
4. Test on headless VM (no monitor) → verify graceful error
5. Verify screenshot size is < 500KB for 1080p
6. Verify old screenshots are overwritten (no storage bloat)
7. Rapid requests (spam button) → verify no duplicate captures or file conflicts
8. Verify admin-only access (non-admin cannot see screenshot button)
