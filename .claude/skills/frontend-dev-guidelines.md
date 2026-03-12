# Frontend Development Guidelines

**Applies To**: Owlette Web Dashboard (`web/` directory)

---

## Project-Specific Patterns

### Directory Layout
```
web/
├── app/                          # App Router (dashboard, deployments, admin, auth, logs)
│   ├── layout.tsx                # Root layout (providers, theme)
│   └── globals.css               # Global styles + CSS variables
├── components/
│   ├── ui/                       # shadcn/ui primitives — DO NOT edit directly
│   └── [Feature].tsx             # Project components
├── contexts/AuthContext.tsx       # Firebase auth (single context for the app)
├── hooks/                        # Custom hooks (useFirestore, useDeployments, etc.)
├── lib/                          # Utilities (firebase.ts, errorHandler.ts, validators.ts)
└── __tests__/                    # Jest tests
    └── __mocks__/firebase.ts     # Comprehensive Firebase mock (use this, don't reinvent)
```

### Auth Pattern

All authenticated pages use `AuthContext`. Don't create alternative auth flows:

```tsx
const { user, loading, signOut } = useAuth()  // from @/contexts/AuthContext
```

Auth guard pattern is in the dashboard layout — new pages under `/dashboard` inherit it automatically.

### Data Fetching

All Firestore data flows through custom hooks in `hooks/`. Don't call Firestore directly from components:

- `useFirestore` — generic real-time document/collection listener
- `useDeployments` — deployment-specific operations
- `useSiteData` — site + machine hierarchy

These hooks handle loading states, error states, and listener cleanup internally.

### shadcn/ui Rules

- Import from `@/components/ui/*` — never edit those files
- To customize: create a wrapper component, don't fork the primitive
- Add new primitives via `npx shadcn@latest add [component-name]`

### Toast Notifications

Use `sonner` (already configured in root layout):
```tsx
import { toast } from 'sonner'
toast.success('Done')
toast.error('Failed to update machine')
```

### Icons

Use `lucide-react` exclusively — don't add other icon libraries.

### Theming

Dark mode via `next-themes` (configured in layout). Use CSS variables from `globals.css` and Tailwind's `dark:` prefix. Don't use hardcoded colors.

---

## Owlette-Specific Gotchas

1. **Real-time listeners must clean up** — every `onSnapshot` needs a return `() => unsubscribe()` in useEffect. We've had memory leak bugs from this.
2. **Server Components can't use Firebase** — Firebase Client SDK requires browser APIs. Any component using auth or Firestore must be `'use client'`.
3. **Site-scoped data** — almost all Firestore paths are `sites/{siteId}/...`. Always scope queries to the user's current site.
4. **Deployment targets are machine arrays** — deployments and project distributions target `machineId[]`, not sites.
5. **Process status comes from agent heartbeats** — don't try to query process status directly. It's pushed by the agent every 10s via Firestore.

---

## When This Skill Activates

Working on files in `web/` or prompts mentioning frontend/React/dashboard/component/UI keywords.
