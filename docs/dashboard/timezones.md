# timezones

Owlette tracks three independent timezone actors and lets each user choose which one acts as the reference frame when the dashboard renders absolute timestamps.

---

## three actors

| actor | source | written by |
|-------|--------|-----------|
| **machine** | The agent's own Windows local timezone | Agent writes `machine_timezone_iana` into the machine's Firestore doc on every heartbeat |
| **user** | The dashboard viewer's preferred IANA timezone | User sets `timezone` in Preferences (default: browser-detected) |
| **site** | The site's configured timezone | Site admin sets it in Manage Sites |

All three are stored as IANA identifiers (e.g. `America/New_York`, `Europe/Berlin`). There is no "offset" or "abbreviation" field — offsets are resolved from the IANA name so that DST transitions work correctly.

---

## display modes

Each user picks one `timeDisplayMode` in preferences. That choice determines which actor's timezone is used to render absolute timestamps (heartbeats, activity logs, crash events, etc.) across the whole dashboard.

| mode | behavior | best for |
|------|----------|----------|
| **`user`** | All times render in the user's `timezone` | Single-operator setups where you always want your own local time |
| **`machine`** _(default)_ | Each machine's times render in **that machine's own** local tz | Distributed kiosks across multiple timezones — "when did the Tokyo kiosk crash?" stays in JST |
| **`site`** | All times render in the site's configured tz | Single-site teams where the site's local time is the shared reference |

In `machine` mode, two cards on the same dashboard page may render times in two different timezones. A `<TimezoneChip>` next to each list of times tells you which actor delivered the timezone so the ambiguity is never silent.

---

## fallback chain

When the primary source for the chosen mode is missing, Owlette falls back in a fixed order (see `getDisplayTimezone()` in `web/lib/timeUtils.ts`):

| mode | fallback order |
|------|----------------|
| `user` | user's tz → browser → `UTC` |
| `machine` | machine tz → site tz → browser → `UTC` |
| `site` | site tz → browser → `UTC` |

`machine` falls back to site (not user) because if the agent hasn't reported its tz yet, the site's tz is the closest "this installation lives in X" approximation. Browser detection is always the last resort before `UTC`.

---

## schedule editor

Schedule editors are **unaffected** by the user's display mode, but they do not all use the same timezone reference. Each scheduler uses the timezone that its feature expects:

| feature | timezone used | notes |
|---------|---------------|-------|
| **process launch windows** | Site timezone | The dashboard schedule editor receives the current site's timezone and labels/previews process windows with that site timezone. The agent evaluates scheduled process windows with the cached site timezone, so "09:00 Mon-Fri" means 09:00 in the site's configured timezone. |
| **scheduled reboots** | Machine local timezone | The reboot dialog shows a machine timezone chip and the agent resolves each reboot entry against the machine's own Windows local timezone. A "03:00" reboot means 03:00 on that machine, even if the site or dashboard user is in another timezone. |

Both behaviors are wall-clock schedules, not absolute UTC instants. Changing your dashboard display mode affects timestamp rendering only; it does not reinterpret saved schedule entries.

---

## related files

- `web/lib/timeUtils.ts` — `getDisplayTimezone()`, `getBrowserTimezone()`, `COMMON_TIMEZONES`, searchable picker helpers
- `web/contexts/AuthContext.tsx` — `UserPreferences.timezone` / `timeDisplayMode` / `timeFormat`
- Agent-side: `machine_timezone_iana` is written alongside other heartbeat metrics
