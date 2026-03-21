# Owlette 2.0 - Architecture Decisions

This document outlines key architectural decisions for Owlette 2.0.

---

## Repository Structure

### Recommended: Monorepo with Clear Separation

We'll use a **monorepo** structure with clear directories for each component:

```
Owlette/
├── agent/                      # Python Windows Service
│   ├── src/
│   │   ├── owlette_service.py
│   │   ├── firebase_client.py
│   │   ├── shared_utils.py
│   │   └── ...
│   ├── config/
│   │   ├── config.json
│   │   └── firebase-credentials.json (ignored)
│   ├── logs/
│   ├── requirements.txt
│   ├── build.bat
│   ├── install.bat
│   ├── owlette_service.spec
│   └── README.md
│
├── web/                     # Next.js Web Dashboard
│   ├── app/
│   │   ├── (auth)/
│   │   ├── (dashboard)/
│   │   └── api/
│   ├── components/
│   ├── lib/
│   │   └── firebase.ts
│   ├── public/
│   ├── package.json
│   ├── next.config.js
│   ├── tsconfig.json
│   └── README.md
│
├── docs/                       # Shared Documentation
│   ├── architecture-decisions.md
│   ├── firebase-setup.md
│   ├── phase2-web-portal.md
│   └── deployment.md
│
├── firebase/                   # Firebase Configuration (optional)
│   ├── firestore.rules
│   └── firestore.indexes.json
│
├── .gitignore
├── README.md                   # Main project README
└── LICENSE
```

### Why Monorepo?

**Advantages:**
- ✅ Single source of truth for the entire product
- ✅ Easy to keep agent and portal versions in sync
- ✅ Shared documentation and issue tracking
- ✅ Simpler CI/CD pipeline
- ✅ Clear separation of concerns with directories
- ✅ Perfect for solo developer

**Each component remains independent:**
- Agent can be built/deployed separately (`agent/build.bat`)
- Portal can be deployed separately (`cd portal && npm run build`)
- Clear boundaries prevent cross-contamination

**Alternative considered:**
- Separate repos (owlette-agent, owlette-web) - rejected because it adds complexity for solo development and version management

---

## Site ID Management

### What is a Site ID?

A **site_id** is a unique identifier for a physical location or logical grouping of machines. Examples:
- `nyc_office_001`
- `london_studio`
- `client_acme_venue_a`

### Development vs Production

#### Development (Phase 1 - Current)
**Manual Configuration:**
1. You manually set `site_id` in `config/config.json`:
   ```json
   "firebase": {
     "enabled": true,
     "site_id": "dev_test_site"
   }
   ```
2. The agent reads this on startup and registers to that site
3. This is fine for testing and development

#### Production (Phase 4 - Machine Onboarding)
**Automated from Web Portal:**

1. **Admin creates site in web dashboard:**
   - Navigate to "Sites" → "Add New Site"
   - Enter site name: "NYC Office"
   - System generates unique `site_id`: `site_abc123xyz`

2. **Admin generates installer:**
   - Click "Generate Installer" for that site
   - Downloads `owlette-installer-nyc-office.exe`
   - **Installer contains embedded `site_id` and Firebase credentials**

3. **Technician installs on machines:**
   - Run `owlette-installer-nyc-office.exe` on any machine
   - Agent automatically registers to `site_abc123xyz`
   - Machine appears in web dashboard under "NYC Office" immediately
   - **No manual configuration needed**

### Site ID Generation Strategy

**Format:** `site_` + 8-character alphanumeric hash

**Why?**
- Short and readable
- URL-safe
- Globally unique
- Sortable by creation time (if using timestamp-based hash)

**Implementation (in web dashboard):**
```typescript
function generateSiteId(): string {
  const timestamp = Date.now().toString(36); // Base36 timestamp
  const random = Math.random().toString(36).substring(2, 7); // Random string
  return `site_${timestamp}${random}`;
}
```

Example: `site_l8xk9p2qr4`

### Site Hierarchy in Firestore

```
sites/
  site_abc123xyz/
    name: "NYC Office"
    createdAt: timestamp
    createdBy: user_id
    machines/
      MACHINE-001/
        presence/
        status/
        commands/
      MACHINE-002/
        presence/
        status/
        commands/

config/
  site_abc123xyz/
    machines/
      MACHINE-001/
        version: "2.0.0"
        processes: [...]
      MACHINE-002/
        version: "2.0.0"
        processes: [...]

users/
  user_xyz/
    email: "admin@example.com"
    role: "admin"
    sites: ["site_abc123xyz", "site_def456uvw"]
```

### Site Assignment Flow

```
Web Portal                    Firestore                    Agent
─────────────────────────────────────────────────────────────────────

1. Create Site
   "NYC Office"
   ──────────>
              sites/site_abc123xyz created

2. Generate Installer
   (with site_abc123xyz)
   <──────────

3. Download installer

4.                                                  Install on machine
                                                    Agent starts
                                                    ────────────>

                                                    Register with
                                                    site_abc123xyz
              sites/site_abc123xyz/
              machines/HOSTNAME created
              <────────────

5. View Dashboard
   ──────────>
              Fetch machines for
              site_abc123xyz
              <──────────

   See machine appear!
```

---

## Migration Path

### Current State (Phase 1)
- Manual `site_id` in config.json
- For development and testing

### Phase 2-3 (Web Portal + Config Management)
- Web portal exists
- Can create sites manually
- Still manual config.json editing on machines

### Phase 4 (Machine Onboarding)
- **Full automation**
- Generate installers from portal
- Zero manual configuration
- Production-ready deployment

### Phase 5 (Software Distribution) ✅
- Remote software installation across multiple machines
- Deployment templates and verification
- Real-time installation tracking

### Phase 6 (Project File Distribution) ✅
- Distribute project files (ZIPs, .toe files, media assets)
- URL-based architecture (zero infrastructure cost)
- Automatic extraction and file verification
- Support for multi-GB TouchDesigner projects

### Phase 7+ (Future)
- Version management and rollback
- Git integration for project files
- Full SaaS product features

---

## File Locations

### Firebase Credentials

**Location:** `config/firebase-credentials.json`

**Why in config/?**
- Logical grouping with other configuration
- Easy to find for administrators
- Keeps root directory clean
- Already gitignored

**Security:**
- Never commit to git (in .gitignore)
- Permissions: Only SYSTEM and Administrators should have access
- In production installers: Embedded in a protected location

### Config Files

```
config/
├── config.json                      # Main configuration (migrated to Firestore)
├── firebase-credentials.json        # Service account key (never commit)
└── firebase_cache.json              # Cached Firestore config (for offline mode)
```

---

## Development Workflow

### For Agent Development

```bash
cd agent/src
python owlette_service.py
```

### For Portal Development

```bash
cd portal
npm install
npm run dev
```

### For Full Stack Testing

**Terminal 1 (Agent):**
```bash
cd agent/src
python owlette_service.py
```

**Terminal 2 (Portal):**
```bash
cd portal
npm run dev
# Visit http://localhost:3000
```

---

## Deployment Strategy

### Agent Deployment
- Build: `agent/build.bat`
- Output: `agent/dist/owlette_service.exe`
- Installer: `agent/installer/owlette_setup.exe`
- Distribution: Downloaded from web dashboard (Phase 4)

### Portal Deployment
- Build: `cd portal && npm run build`
- Deploy to: Vercel (recommended) or Firebase Hosting
- URL: `https://owlette.your-domain.com`

### Firebase Deployment
- Rules: `firebase deploy --only firestore:rules`
- Indexes: Automatically created or use `firebase/firestore.indexes.json`

---

## Summary

**Site ID:**
- Development: Manually set in config.json (current)
- Production: Auto-embedded in installers (Phase 4)

**Repo Structure:**
- Monorepo with `agent/` and `web/` directories
- Clear separation, easy management
- Perfect for solo developer building a product

**Next Steps:**
1. Phase 1: Test Firebase integration ✅
2. Phase 2: Build web dashboard (Next.js)
3. Phase 3: Config management from web
4. Phase 4: Auto-installer generation with embedded site_id
5. Phase 5: Software distribution
