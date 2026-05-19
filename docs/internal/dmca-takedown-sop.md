# DMCA takedown — operator SOP

**Wave 0.2.** 17 U.S.C. § 512(c) safe-harbor compliance for roost.

> **Legal context.** Once roost enables user-uploaded content to external accounts, owlette operates a user-generated-content platform subject to DMCA. *BMG v. Cox* established that repeat-infringer policies are **not optional** — failure to reasonably implement one loses safe-harbor protection and exposes the platform to ~$25M+ contributory liability. This SOP is the implementation.

## Pre-launch checklist

| item | owner | status |
|---|---|---|
| Designated agent registered at `copyright.gov/dmca-directory/` ($6 + $90/yr renewal) | operator | pending (wave 0.2) |
| Takedown form live at `/legal/dmca` | **done** (wave 0.2) | ✅ |
| 24-48 hour response SOP (this doc) | **done** (wave 0.2) | ✅ |
| Repeat-infringer log + 3-strike automation | **done** (wave 0.2) | ✅ |
| Counter-notice flow | follow-up | deferred |
| Subpoena-response playbook | follow-up | deferred |

The designated-agent registration **must happen before** external accounts can receive v2 upload features. Without it, safe-harbor doesn't apply.

## Receiving a notice

Notices arrive via `POST /api/legal/dmca` (form) OR by email to the registered designated-agent address OR by postal mail. All three feed the same `dmca_notices` firestore collection, though postal mail requires manual entry.

### Required fields (17 U.S.C. § 512(c)(3)(A))

A notice is **elements-complete** when it contains all six of:

1. Physical or electronic signature of the complainant (or their agent)
2. Identification of the copyrighted work claimed to be infringed
3. Identification of the allegedly infringing material — specific enough for the platform to locate it (URLs, file paths, content IDs)
4. Contact info of the complainant (name, address, phone, email)
5. Good-faith belief statement ("I have a good faith belief that use of the material … is not authorized by the copyright owner, its agent, or the law")
6. Accuracy + perjury statement ("I swear, under penalty of perjury, that the information in this notification is accurate, and … that I am the copyright owner or authorised to act on behalf of the owner")

A notice missing any of these is **not elements-complete** — we are NOT required to act on it but SHOULD contact the complainant to request the missing information within 24 hours.

## Response SLA

| step | deadline | actor |
|---|---|---|
| Acknowledge receipt | within 4 business hours | automated email from `/api/legal/dmca` |
| Elements-complete check | within 24 hours | designated agent |
| Take down flagged material | within **48 hours** of elements-complete | ops on-call |
| Notify uploader (counter-notice opportunity) | same 48-hour window | automated |
| Log notice against uploader's strike count | at takedown time | automated (wave 0.2 helper) |

48-hour takedown is our policy, not a statutory requirement (DMCA says "expeditiously" without defining it). Courts have accepted 72 hours; 48 gives us margin.

## 3-strike termination policy

Per `web/lib/dmcaLogic.ts`:

- **Strike 1**: removal + email warning to the uploader, log the strike.
- **Strike 2**: removal + 14-day suspension of upload privileges, escalate email.
- **Strike 3**: removal + permanent account termination, full backup of their data made available to them for 30 days, then purged.

Strikes are counted per-user-account, not per-site. A user with multiple sites terminates on all of them.

Strikes **expire after 12 months** — this matches industry convention (YouTube, Google Drive) and keeps the policy from being weaponised by targeted serial takedowns.

**Contest path**: on strikes 1 and 2, the user can file a counter-notice via `/legal/dmca/counter` (deferred follow-up). A valid counter-notice pauses the strike pending legal resolution.

## Operator playbook — incoming notice

When a notice arrives:

1. **Read** the auto-generated acknowledgement in the `dmca_notices` firestore doc. If elements-complete:
   - Material is already flagged for takedown in the doc (`status: pending_takedown`).
   - Locate the content by the `identifiedMaterial` field + the uploader's siteId.
2. **Take down** via the admin dashboard (for roost content: deletion of the synced_folder's current manifest, or revocation of the signed URL for a specific chunk).
3. **Log the takedown** — set `dmca_notices/{id}.status = 'taken_down'`, stamp `takenDownAt`, record the acting admin's UID.
4. **Strike the uploader** — call `recordStrike(uid)` which increments `repeat_infringers/{uid}.strikeCount` + triggers the corresponding notification.
5. **Notify the uploader** — automated email from the strike handler, but verify it went out.

If the notice is **abuse** (e.g., weaponised DMCA from a competitor):
1. Document the evidence in the notice's `adminNotes` field.
2. Do NOT take down (this defeats safe-harbor only if done in bad faith; the standard is reasonable good-faith evaluation — not infallibility).
3. Cite 17 U.S.C. § 512(f) which creates liability for the complainant for knowing misrepresentation.

## Data retention

- `dmca_notices` — permanent. Never delete. BigQuery cold-store via the audit-log exporter (wave 2b.7) at 7-year minimum.
- `repeat_infringers` — per-user aggregate, never purged except when the user account itself is deleted (GDPR right to erasure — but note the strikes themselves can remain anonymised to preserve the 12-month expiry counter).
- Uploader-provided content that was taken down — retained for **14 days** in case of counter-notice, then purged unless legal hold attaches.

## Escalation

- Legal counsel within 1 business day for: subpoenas, multi-jurisdictional notices, obvious abuse, any notice referencing criminal matters.
- Status page banner if a takedown affects more than one tenant (rare — would indicate cross-tenant data leakage that itself is a P0 incident).

## Follow-up tasks (not in 0.2 scope)

- Counter-notice form at `/legal/dmca/counter`
- Automated email templates for acknowledgement, takedown notification, counter-notice receipt
- Subpoena-response playbook
- Admin dashboard view of the `dmca_notices` queue with actionable buttons
