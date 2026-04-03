# Troubleshooting

Cross-cutting troubleshooting guide for common issues across the entire owlette system.

---

## Agent Won't Connect to Cloud

**Symptoms**: Machine shows offline in dashboard, agent logs show connection errors.

**Check**:

1. Verify internet connectivity on the agent machine
2. Check firewall rules — outbound HTTPS (port 443) must be allowed to `*.googleapis.com` and `*.firebaseio.com`
3. Check `C:\ProgramData\Owlette\logs\service.log` for specific errors
4. Verify `firebase.enabled` is `true` in config.json
5. Verify `firebase.site_id` matches a site that exists in Firestore

**Common errors**:

| Log Message | Cause | Fix |
|-------------|-------|-----|
| "Agent not authenticated" | Missing or corrupt tokens | Re-register with a new code |
| "HTTP error 403" | Firestore rules blocking access | Verify security rules are deployed |
| "Token expired" | Refresh failed | Check refresh token in logs, re-register if needed |
| "Connection refused" | Firewall or proxy | Allow outbound HTTPS |

---

## Dashboard Shows Machine Offline

**Symptoms**: Agent is running but dashboard shows offline.

1. **Check heartbeat age** — If last seen was recently, the machine may be experiencing intermittent connectivity
2. **Check agent service**: `sc query OwletteService` (should show RUNNING)
3. **Check ConnectionManager state** in logs — look for BACKOFF or DISCONNECTED
4. **Verify site_id** — Agent and dashboard must be looking at the same site
5. **Check Firestore directly** — Go to Firebase Console → Firestore → `sites/{siteId}/machines/{machineId}/presence` → check `lastHeartbeat`

---

## Processes Not Auto-Restarting

1. Verify `autolaunch` is `true` for the process
2. Check if `relaunch_attempts` limit was reached (reboot prompt should appear)
3. Verify `exe_path` exists on the machine (INACTIVE state means file not found)
4. Check agent logs for launch errors
5. Verify the service is running and the main loop is executing (look for periodic log entries)

---

## OAuth Token Issues

### "Agent not authenticated - no refresh token found"

The encrypted token file is missing or unreadable.

**Fix**: Re-pair the agent:

1. Delete the token file: `del C:\ProgramData\Owlette\.tokens.enc`
2. Run the pairing flow: `C:\ProgramData\Owlette\python\python.exe C:\ProgramData\Owlette\agent\src\configure_site.py`
3. Authorize on the web page that opens, then restart the service

### Token refresh failing

Check `service.log` for refresh errors. Common causes:

- **Machine ID mismatch** — The machine was renamed since registration
- **Token revoked** — An admin revoked the token from the dashboard
- **Network issue** — Can't reach the refresh endpoint

---

## Deployment Stuck

**Symptoms**: Deployment shows "downloading" or "installing" indefinitely.

1. Check agent logs for download/install progress
2. Verify the installer URL is accessible from the agent machine (test in browser)
3. Check if the installation timed out (default: 40 minutes)
4. For large installers on slow connections, the download may simply be slow
5. Try cancelling and re-deploying

---

## Project Distribution Failed

1. **Download failed** — Test URL in browser; ensure it's a direct download link
2. **Extraction failed** — Verify the ZIP is valid; check disk space
3. **Verification failed** — Check that verify file paths match the actual ZIP structure
4. **Permission denied** — The extract path may not be writable

---

## MFA Issues

### Lost Authenticator

Use one of your **backup codes** at the MFA prompt. Each code can only be used once.

### No Backup Codes

Contact an admin to disable MFA on your account by clearing the `mfaEnabled`, `mfaSecret`, and `mfaBackupCodes` fields in your Firestore user document.

### Code Not Working

- Ensure your device's clock is synchronized (TOTP is time-based)
- Codes expire every 30 seconds — enter the current one
- Verify you're using the correct account in your authenticator app

---

## Cortex Not Responding

1. **No LLM key configured** — Check Cortex settings for API key
2. **Invalid API key** — Verify the key is correct and has credits
3. **Machine offline** — Cortex checks machine status before executing tools
4. **Tool timeout** — Some tools may take longer than 30 seconds; try again
5. **Rate limited** — The API may be rate-limiting requests

---

## Email Alerts Not Working

1. Verify `RESEND_API_KEY` environment variable is set in Railway
2. Check that the Resend API key is valid
3. Verify `CRON_SECRET` is configured for health check cron
4. Check Railway cron schedule is set: `*/5 * * * *`
5. Send a test email from Admin Panel → Email Test
6. Check spam/junk folders

---

## Dashboard Performance Issues

### Slow Loading

- **Cold starts** (Railway Hobby plan) — Upgrade to Pro for no cold starts
- **Large dataset** — Many machines/processes increase Firestore reads
- **Bundle size** — Check `.next/static` output during build

### Real-Time Updates Not Working

- Check browser console for Firestore listener errors
- Verify Firebase config is correct
- Try hard refresh (Ctrl+Shift+R)
- Check if the Firestore quota has been exceeded

---

## Log Locations

### Agent Logs

| Log | Path |
|-----|------|
| Service | `C:\ProgramData\Owlette\logs\service.log` |
| GUI | `C:\ProgramData\Owlette\logs\gui.log` |
| Tray | `C:\ProgramData\Owlette\logs\tray.log` |
| Installer | `C:\ProgramData\Owlette\logs\setup.log` |

### Dashboard Logs

| Log | Location |
|-----|----------|
| Build logs | Railway → Deployments → [deployment] → Logs |
| Runtime logs | Railway → Deployments → [latest] → Logs |
| Client errors | Browser → F12 → Console |

### Firestore Logs

| Log | Location |
|-----|----------|
| Rule evaluations | Firebase Console → Firestore → Rules → Monitoring |
| Usage metrics | Firebase Console → Firestore → Usage |
| Auth events | Firebase Console → Authentication → Users |

---

## Debug Mode

Run the agent in debug mode for detailed console output:

```bash
cd C:\ProgramData\Owlette\agent\src
python owlette_service.py debug
```

Requires an elevated (Administrator) command prompt. Shows real-time logging of all service operations.

---

## Getting Help

1. Check the relevant section of this documentation
2. Review agent logs and browser console for specific error messages
3. Check the [Firestore Data Model](reference/firestore-data-model.md) to verify data structure
4. Open an issue on [GitHub](https://github.com/theexperiential/owlette/issues)
