# Frontend Development Guidelines

**Version**: 1.0.0
**Last Updated**: 2025-01-31
**Applies To**: Owlette Web Dashboard (`web/` directory)

## Overview

This skill provides comprehensive guidelines for developing the Owlette web dashboard using Next.js 16, React 19, TypeScript, Tailwind CSS, and Firebase. Follow these patterns to ensure consistency, maintainability, and adherence to best practices.

---

## Tech Stack Quick Reference

- **Framework**: Next.js 16.0.1 (App Router with React 19)
- **Language**: TypeScript 5.x (strict mode enabled)
- **Styling**: Tailwind CSS 4.x + tw-animate-css
- **UI Components**: shadcn/ui (Radix UI primitives)
- **State Management**: React Context (AuthContext) + local state
- **Data Fetching**: Custom hooks (`useFirestore`, `useDeployments`)
- **Authentication**: Firebase Auth (Email/Password, Google OAuth)
- **Database**: Cloud Firestore (real-time listeners)
- **Icons**: lucide-react
- **Notifications**: sonner (toast notifications)
- **Dates**: date-fns
- **Theme**: next-themes (dark mode support)

---

## Directory Structure

```
web/
├── app/                          # Next.js App Router
│   ├── layout.tsx                # Root layout (providers, theme)
│   ├── page.tsx                  # Home page (redirect logic)
│   ├── globals.css               # Global styles
│   ├── dashboard/
│   │   └── page.tsx              # Main dashboard (Server Component)
│   ├── deployments/
│   │   └── page.tsx              # Deployment management
│   ├── login/
│   │   └── page.tsx              # Login page
│   └── register/
│       └── page.tsx              # Registration page
│
├── components/
│   ├── ui/                       # shadcn/ui components (don't edit directly)
│   │   ├── button.tsx
│   │   ├── dialog.tsx
│   │   ├── card.tsx
│   │   └── ...
│   └── [Custom].tsx              # Project-specific components
│
├── contexts/
│   └── AuthContext.tsx           # Firebase authentication context
│
├── hooks/
│   ├── useFirestore.ts           # Firestore operations
│   ├── useDeployments.ts         # Deployment management
│   └── use[Feature].ts           # Feature-specific hooks
│
├── lib/
│   ├── firebase.ts               # Firebase initialization
│   ├── errorHandler.ts           # Error handling utilities
│   ├── validators.ts             # Input validation
│   └── utils.ts                  # General utilities (cn helper)
│
└── public/                       # Static assets
```

---

## Core Principles

### 1. Server Components by Default

**Use Server Components** unless you need:
- Client-side interactivity (onClick, onChange, etc.)
- Browser APIs (window, localStorage, etc.)
- React hooks (useState, useEffect, etc.)
- Context providers or consumers

```tsx
// ✅ GOOD - Server Component (default)
export default async function DashboardPage() {
  return <div>Dashboard</div>
}

// ✅ GOOD - Client Component (when needed)
'use client'
import { useState } from 'react'

export default function InteractiveDashboard() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>{count}</button>
}
```

**Resource**: See [nextjs-patterns.md](resources/nextjs-patterns.md) for detailed App Router patterns

### 2. TypeScript Strict Mode

All code must be fully typed with **no `any` types** unless absolutely necessary.

```tsx
// ❌ BAD
const handleSubmit = (data: any) => { ... }

// ✅ GOOD
interface SubmitData {
  email: string
  password: string
}

const handleSubmit = (data: SubmitData) => { ... }
```

**Resource**: See [typescript-standards.md](resources/typescript-standards.md)

### 3. Component Patterns

Follow React 19 best practices:
- Use function components (not classes)
- Custom hooks for reusable logic
- Prop drilling max 2 levels (use Context for deeper)
- Keep components focused (single responsibility)

```tsx
// ✅ GOOD - Small, focused component
interface MachineCardProps {
  machine: Machine
  onSelect: (id: string) => void
}

export function MachineCard({ machine, onSelect }: MachineCardProps) {
  return (
    <Card onClick={() => onSelect(machine.id)}>
      <CardHeader>{machine.name}</CardHeader>
      {/* ... */}
    </Card>
  )
}
```

**Resource**: See [react-patterns.md](resources/react-patterns.md)

### 4. Tailwind CSS First

Use Tailwind utilities for all styling. Only use custom CSS for:
- Global styles (typography, resets)
- Complex animations not covered by tw-animate-css
- Third-party library overrides

```tsx
// ✅ GOOD
<div className="flex items-center gap-4 p-6 rounded-lg bg-background">

// ❌ BAD - inline styles
<div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
```

**Resource**: See [ui-components.md](resources/ui-components.md)

### 5. Error Handling

All async operations must have error handling:

```tsx
// ✅ GOOD
try {
  await someAsyncOperation()
  toast.success('Operation successful')
} catch (error) {
  console.error('Operation failed:', error)
  toast.error('Failed to complete operation')
  // Optionally: report to error tracking service
}
```

**Resource**: See [error-handling.md](resources/error-handling.md)

---

## Firebase Integration

### Authentication

Use `AuthContext` for all auth operations:

```tsx
'use client'
import { useAuth } from '@/contexts/AuthContext'

export function ProfileButton() {
  const { user, signOut } = useAuth()

  if (!user) return null

  return (
    <Button onClick={signOut}>
      Sign Out ({user.email})
    </Button>
  )
}
```

### Firestore Operations

Use custom hooks (`useFirestore`, `useDeployments`) for data operations:

```tsx
'use client'
import { useFirestore } from '@/hooks/useFirestore'

export function MachineList() {
  const { data: machines, loading, error } = useFirestore('machines')

  if (loading) return <Skeleton />
  if (error) return <ErrorMessage error={error} />

  return (
    <div>
      {machines?.map(machine => (
        <MachineCard key={machine.id} machine={machine} />
      ))}
    </div>
  )
}
```

**Resource**: See [firebase-client.md](resources/firebase-client.md)

---

## Common Patterns

### Forms

Use controlled components with React Hook Form (if added) or simple useState:

```tsx
'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { validateEmail } from '@/lib/validators'

export function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validation
    const newErrors: Record<string, string> = {}
    if (!validateEmail(email)) {
      newErrors.email = 'Invalid email address'
    }
    if (password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters'
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    // Submit
    try {
      await signIn(email, password)
      toast.success('Login successful')
    } catch (error) {
      console.error('Login failed:', error)
      toast.error('Login failed. Please try again.')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
        />
        {errors.email && <p className="text-sm text-destructive">{errors.email}</p>}
      </div>
      <div>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        {errors.password && <p className="text-sm text-destructive">{errors.password}</p>}
      </div>
      <Button type="submit">Sign In</Button>
    </form>
  )
}
```

### Real-Time Data

Use Firestore listeners for live updates:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'

export function useMachineStatus(machineId: string) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, `machines/${machineId}/status`),
      (snapshot) => {
        setStatus(snapshot.data())
        setLoading(false)
      },
      (error) => {
        console.error('Status listener error:', error)
        setLoading(false)
      }
    )

    return () => unsubscribe()
  }, [machineId])

  return { status, loading }
}
```

### Loading States

Show loading indicators for async operations:

```tsx
import { Skeleton } from '@/components/ui/skeleton'

export function MachineList() {
  const { data, loading, error } = useFirestore('machines')

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  if (error) {
    return <ErrorMessage error={error} />
  }

  // Render data...
}
```

### Error States

Use toast notifications for user-facing errors:

```tsx
import { toast } from 'sonner'

try {
  await updateMachine(data)
  toast.success('Machine updated successfully')
} catch (error) {
  console.error('Update failed:', error)
  toast.error('Failed to update machine. Please try again.')
}
```

---

## shadcn/ui Components

### Installation

Add new components as needed:

```bash
npx shadcn@latest add [component-name]
```

### Usage

Import from `@/components/ui/*`:

```tsx
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
```

### Customization

**DO NOT** edit components in `components/ui/` directly. Instead:

1. Create a new component that wraps the ui component
2. Use Tailwind classes to customize
3. Use `className` prop to override styles

```tsx
// ✅ GOOD
import { Button } from '@/components/ui/button'

export function PrimaryButton({ children, ...props }) {
  return (
    <Button className="bg-primary hover:bg-primary/90" {...props}>
      {children}
    </Button>
  )
}

// ❌ BAD - editing components/ui/button.tsx directly
```

---

## Routing & Navigation

### File-Based Routing

Next.js App Router uses file-based routing:

```
app/
├── page.tsx                    → /
├── dashboard/
│   └── page.tsx                → /dashboard
├── deployments/
│   └── page.tsx                → /deployments
└── login/
    └── page.tsx                → /login
```

### Navigation

Use `next/link` for navigation:

```tsx
import Link from 'next/link'

<Link href="/dashboard" className="text-primary hover:underline">
  Go to Dashboard
</Link>
```

Use `useRouter` for programmatic navigation:

```tsx
'use client'
import { useRouter } from 'next/navigation'

export function LoginSuccess() {
  const router = useRouter()

  useEffect(() => {
    router.push('/dashboard')
  }, [router])
}
```

### Protected Routes

Wrap pages in auth checks:

```tsx
'use client'
import { useAuth } from '@/contexts/AuthContext'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export default function DashboardPage() {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login')
    }
  }, [user, loading, router])

  if (loading) return <LoadingSpinner />
  if (!user) return null

  return <Dashboard />
}
```

---

## Performance Optimization

### Code Splitting

Use dynamic imports for heavy components:

```tsx
import dynamic from 'next/dynamic'

const HeavyChart = dynamic(() => import('@/components/HeavyChart'), {
  loading: () => <Skeleton className="h-64 w-full" />,
  ssr: false
})
```

### Memoization

Use `useMemo` and `useCallback` for expensive calculations:

```tsx
import { useMemo, useCallback } from 'react'

const sortedMachines = useMemo(() => {
  return machines.sort((a, b) => a.name.localeCompare(b.name))
}, [machines])

const handleSelect = useCallback((id: string) => {
  console.log('Selected:', id)
}, [])
```

### Image Optimization

Use Next.js Image component:

```tsx
import Image from 'next/image'

<Image
  src="/logo.png"
  alt="Owlette Logo"
  width={200}
  height={200}
  priority  // For above-the-fold images
/>
```

---

## Accessibility

### Semantic HTML

Use proper HTML elements:

```tsx
// ✅ GOOD
<button onClick={handleClick}>Click me</button>
<nav>
  <Link href="/dashboard">Dashboard</Link>
</nav>

// ❌ BAD
<div onClick={handleClick}>Click me</div>
```

### ARIA Labels

Add labels for screen readers:

```tsx
<button aria-label="Close dialog" onClick={onClose}>
  <X className="h-4 w-4" />
</button>
```

### Keyboard Navigation

Ensure all interactive elements are keyboard-accessible (shadcn/ui handles this for you).

---

## Testing

Write tests for:
- Complex components
- Custom hooks
- Utility functions
- Critical user flows

```tsx
// __tests__/components/MachineCard.test.tsx
import { render, screen } from '@testing-library/react'
import { MachineCard } from '@/components/MachineCard'

test('renders machine name', () => {
  const machine = { id: '1', name: 'Test Machine' }
  render(<MachineCard machine={machine} onSelect={() => {}} />)
  expect(screen.getByText('Test Machine')).toBeInTheDocument()
})
```

**Resource**: See [testing-guidelines.md](../testing-guidelines.md)

---

## Code Style

### Naming Conventions

- **Components**: PascalCase (`MachineCard.tsx`)
- **Hooks**: camelCase starting with `use` (`useFirestore.ts`)
- **Utilities**: camelCase (`validators.ts`)
- **Types**: PascalCase (`interface Machine { ... }`)
- **Constants**: UPPER_SNAKE_CASE (`const API_URL = ...`)

### File Organization

```tsx
// 1. Imports (external first, then internal)
import { useState } from 'react'
import { Button } from '@/components/ui/button'

// 2. Types
interface ComponentProps {
  // ...
}

// 3. Component
export function Component({ props }: ComponentProps) {
  // 3a. Hooks
  const [state, setState] = useState()

  // 3b. Handlers
  const handleClick = () => { ... }

  // 3c. Effects
  useEffect(() => { ... }, [])

  // 3d. Render
  return (
    <div>...</div>
  )
}
```

### Import Aliases

Use `@/` alias for imports:

```tsx
// ✅ GOOD
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'

// ❌ BAD
import { cn } from '../../lib/utils'
```

---

## Common Mistakes to Avoid

### ❌ Using `any` Type

```tsx
// ❌ BAD
const handleData = (data: any) => { ... }

// ✅ GOOD
interface Data {
  id: string
  name: string
}
const handleData = (data: Data) => { ... }
```

### ❌ Missing Error Handling

```tsx
// ❌ BAD
const loadData = async () => {
  const data = await fetchData()
  setData(data)
}

// ✅ GOOD
const loadData = async () => {
  try {
    const data = await fetchData()
    setData(data)
  } catch (error) {
    console.error('Failed to load data:', error)
    toast.error('Failed to load data')
  }
}
```

### ❌ Client Component Overuse

```tsx
// ❌ BAD - making entire page client component unnecessarily
'use client'
export default function Page() {
  return (
    <div>
      <StaticHeader />
      <InteractiveButton />
    </div>
  )
}

// ✅ GOOD - only interactive parts are client components
export default function Page() {
  return (
    <div>
      <StaticHeader />
      <InteractiveButton />  {/* This component has 'use client' */}
    </div>
  )
}
```

### ❌ Unsubscribed Listeners

```tsx
// ❌ BAD - memory leak
useEffect(() => {
  onSnapshot(docRef, (snapshot) => {
    setData(snapshot.data())
  })
}, [])

// ✅ GOOD - cleanup function
useEffect(() => {
  const unsubscribe = onSnapshot(docRef, (snapshot) => {
    setData(snapshot.data())
  })
  return () => unsubscribe()
}, [])
```

---

## Resources

For detailed information, see these resource files:

- [nextjs-patterns.md](resources/nextjs-patterns.md) - App Router, routing, data fetching, metadata
- [react-patterns.md](resources/react-patterns.md) - React 19 features, hooks, component patterns
- [typescript-standards.md](resources/typescript-standards.md) - TypeScript best practices, types, generics
- [firebase-client.md](resources/firebase-client.md) - Auth, Firestore, real-time listeners, offline
- [ui-components.md](resources/ui-components.md) - shadcn/ui usage, Tailwind patterns, theming
- [error-handling.md](resources/error-handling.md) - Error boundaries, toast notifications, logging

---

## When This Skill Activates

This skill automatically activates when:

- Working on files in `web/app/**/*.tsx` or `web/components/**/*.tsx`
- Prompt contains keywords: "frontend", "react", "next", "component", "dashboard", "UI"
- Intent patterns match: creating/modifying components, pages, or routes

---

**Version**: 1.0.0
**Last Updated**: 2025-01-31
**Maintained By**: Owlette Development Team
