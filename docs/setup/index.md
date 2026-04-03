# self-hosting

owlette is available as a hosted service at [owlette.app](https://owlette.app) — no setup required. But if you want to run your own instance, this section covers deploying the full stack yourself.

---

## why self-host?

- **Data sovereignty** — Keep all data in your own Firebase project
- **Custom domain** — Run the dashboard on your own URL
- **Full control** — Modify the codebase, add features, integrate with your infrastructure
- **Development** — Contribute to owlette or build on top of it

---

## what you'll need

| Requirement | Purpose |
|-------------|---------|
| **Firebase account** | Database and authentication backend (free tier works) |
| **Railway account** (or any Node.js host) | Web dashboard hosting |
| **GitHub repository** | Source code and CI/CD |
| **Node.js 18+** | Local development |
| **Windows 10+ machine** | Agent installation target |

---

## setup order

```
1. Firebase Setup          → Create project, enable Firestore + Auth
      │
2. Firestore Rules         → Deploy security rules
      │
3. Web Deployment          → Deploy to Railway, configure env vars
      │
4. First Admin Account     → Register + promote in Firestore
      │
5. Agent Installation      → Download + install on target machines
```

---

## in this section

- [**Firebase Setup**](firebase.md) — Create project, enable services, generate credentials
- [**Firestore Rules**](firestore-rules.md) — Deploy and test security rules
- [**Web Deployment**](web-deployment.md) — Deploy to Railway with environment configuration
- [**Environment Variables**](environment-variables.md) — Complete reference for all configuration variables

## technical reference

- [**REST API**](../reference/api.md) — All HTTP endpoints with request/response schemas
- [**Firestore Data Model**](../reference/firestore-data-model.md) — Complete collection and document schema
- [**Authentication**](../reference/authentication.md) — User auth, agent OAuth, MFA, and session management
- [**Cortex Tools**](../reference/cortex-tools.md) — All 29 MCP tools with parameters and tiers
- [**Agent Commands**](../reference/agent-commands.md) — Firestore command types and payloads
