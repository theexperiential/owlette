# legal + production-readiness — plan
**Last updated**: 2026-04-26 | **Status**: Planned (cost-gated)

revive when funding for legal + insurance + EV cert is available. see [context.md](context.md) for motivation; [tasks.md](tasks.md) for actionable items.

---

## phases (when revived — runs sequentially with parallel external lead times)

```
phase 1   external procurement starts                    (~ week 0, all in parallel)
  ├─ 1.1  lawyer retainer signed
  ├─ 1.2  insurance broker conversations started
  └─ 1.3  EV cert procurement started

phase 2   external lead times running                    (weeks 1-6)
  └─ wait — engineering work paused on this plan

phase 3   legal package published                        (~ weeks 4-6 after lawyer engagement)
  ├─ 3.1  ToS + privacy + AUP + DMCA drafts arrive
  ├─ 3.2  legal review iterations
  ├─ 3.3  publish to owlette.app/legal/* + footer + installer EULA
  └─ 3.4  insurance certificate of insurance on file

phase 4   cert arrives + installer signing               (~ week 6-8)
  ├─ 4.1  EV cert delivered (hardware token)
  ├─ 4.2  hsm/kms storage + signing runbook
  ├─ 4.3  authenticode signing in build pipeline
  └─ 4.4  ship signed installer; verify SmartScreen acceptance

phase 5   production launch unblocked                    (~ week 8-10)
  ├─ 5.1  founder communications: customer email + announcement
  └─ 5.2  external customer signups can be accepted
```

---

## phase 1 — external procurement

**duration**: 1 week of founder time. all three procurements happen in parallel. nothing engineering can do until phase 3+.

### 1.1 — lawyer retainer signed
engage cooley go, gunderson, or a fractional gc service. brief: ToS + privacy policy + AUP + DMCA policy as a coherent package. ~$3-8k for first draft.

### 1.2 — insurance broker conversations
contact vouch, embroker, coalition. explain the product (file distribution to windows machines, content-addressed storage, third-party content uploads). request quotes on E&O + cyber + media liability. ~$1.5-5k/yr at seed stage.

### 1.3 — EV cert procurement
sectigo or digicert. order EV code-signing cert. **6-8 week lead time** for hardware token shipping. start as soon as funding lands.

### 1.4 — OFAC sanctions screening (vendor + integration)
pick complyadvantage or sanctions.io. create vendor account ($100-500/mo). 1-day engineering integration into the signup flow: check email domain + IP geolocation against OFAC sanctioned countries on every new signup; block matches with 403 + clear message. only required when a public signup form exists; can stay deferred indefinitely if the product remains invite-only.

---

## phase 2 — wait

**duration**: 4-6 weeks. external lead times. nothing to do.

if engineering bandwidth is available during this window, the highest-leverage parallel work is:
- writing the cert-storage runbook (phase 4.2)
- prepping the build-pipeline signing changes (phase 4.3) so they're ready to land the day the cert arrives
- reviewing the existing DMCA SOP and identifying gaps the lawyer should fill

---

## phase 3 — legal package published

**duration**: ~2 weeks once first drafts arrive. mostly review + publishing.

### 3.1-3.2 — drafts + review
lawyer delivers first drafts. founder + (ideally) one other reviewer reviews. iterate ~1-2 rounds.

### 3.3 — publish
- create next.js pages at `web/app/legal/{terms,privacy,aup,dmca}/page.tsx`
- copy approved text from lawyer-delivered markdown
- add footer links
- update installer EULA (`agent/owlette_installer.iss`) to reference ToS

### 3.4 — insurance bound
once policies are quoted + accepted, sign + pay first premium. certificate of insurance on file.

---

## phase 4 — cert + signing

**duration**: ~1 week of engineering once cert arrives.

### 4.1 — cert delivery
hardware token ships from sectigo/digicert. founder receives. cert imported into hsm or kms.

### 4.2 — storage runbook
new `dev/planned/legal/reference/cert-storage-runbook.md` covering: where the token lives, who has access, recovery procedure if lost, signing operation walkthrough. **operational discipline is the security here, not the cert itself.**

### 4.3 — authenticode signing in build pipeline
modify `agent/build_installer_full.bat` to call `signtool.exe sign /a /tr <timestamp-server> /td sha256 /fd sha256 <installer.exe>` after the inno setup compile step. requires the build machine to have access to the cert (via the hsm or a scoped credential).

### 4.4 — ship signed installer
build a v3.0.x installer signed with the new cert. download on a fresh windows install + verify SmartScreen accepts without warning. document in changelog.

---

## phase 5 — production launch

**duration**: ~1 week of founder/comms time. no engineering work.

### 5.1 — comms
- email existing internal users: "owlette is open for external customers as of YYYY-MM-DD"
- update marketing site / landing page
- twitter / linkedin announcement

### 5.2 — accept signups
external signup flow lights up. monitor for OFAC-flagged signups, abuse, anything unexpected.

---

## risks

- **lawyer drafts arrive late** — startup-firm engagement letters often slip. mitigation: pay rush retainer if available; have a backup firm contacted.
- **EV cert sits in customs** — international shipping of hardware tokens can take 2+ weeks. mitigation: order to the address with the most predictable customs handling (us-based founder address recommended).
- **insurance broker can't underwrite** — newer broker startups (vouch) sometimes can't bind certain segments. mitigation: contact 3 brokers in parallel.
- **legal review reveals product changes needed** — e.g., the lawyer says "you can't host this kind of content without a content-moderation policy." mitigation: start the lawyer engagement EARLY so any product implications surface before launch is announced.
- **funding doesn't materialize** — this plan stays in `dev/planned/` indefinitely. internal use of roost v2 continues unaffected.

## dependencies + ordering

**blocks**: external customer launch of project-distribution-v2 (the v3.0.0 cutover scenario). without these items, roost v2 can ship to internal/friend users only.

**blocked by**: funding availability. nothing else.

**adjacent**: `dev/planned/status-page/` (also cost-gated at $20/mo). same revival trigger ideal — when one comes alive, the other should too.

## success criteria

per [context.md](context.md):
1. signed lawyer engagement letter.
2. four legal docs published at `/legal/*`.
3. insurance certificate on file.
4. EV cert in hsm/kms; signed dummy installer succeeds.
5. production installer signed + SmartScreen accepts without warning.
6. external customer can sign up + accept ToS + use platform.
