# Firebase Integration Guidelines

**Version**: 1.0.0
**Last Updated**: 2025-01-31
**Applies To**: Both web dashboard and Python agent

## Overview

This skill provides patterns for integrating with Firebase services (Authentication, Firestore) across both the web dashboard (client SDK) and Python agent (Admin SDK). Owlette uses Firebase as its serverless backend with bidirectional real-time sync.

---

## Firebase Services Used

- **Firebase Authentication**: User authentication (Email/Password, Google OAuth)
- **Cloud Firestore**: Real-time NoSQL database with offline support
- **Firebase Admin SDK**: Server-side operations (Python agent)
- **Firebase Client SDK**: Client-side operations (web dashboard)

---

## Firestore Data Structure

```
firestore/
├── sites/{siteId}/
│   ├── name: string
│   ├── createdAt: timestamp
│   └── machines/{machineId}/
│       ├── presence/              # Heartbeat every 30s
│       │   ├── online: boolean
│       │   └── lastHeartbeat: timestamp
│       ├── status/                # Metrics every 60s
│       │   ├── cpu: number
│       │   ├── memory: number
│       │   ├── disk: number
│       │   ├── gpu: number
│       │   └── processes: map
│       └── commands/              # Bidirectional commands
│           ├── pending/{commandId}/
│           │   ├── type: string
│           │   ├── createdAt: timestamp
│           │   └── [params]: any
│           └── completed/{commandId}/
│               ├── type: string
│               ├── result: object
│               └── completedAt: timestamp
├── config/{siteId}/
│   └── machines/{machineId}/
│       ├── version: string
│       └── processes: array
├── users/{userId}/
│   ├── email: string
│   ├── role: string
│   ├── createdAt: timestamp
│   └── sites: array
├── deployments/{deploymentId}/
│   ├── installerUrl: string
│   ├── silentFlags: string
│   ├── targetMachines: array
│   ├── status: string ('pending' | 'in_progress' | 'completed' | 'failed')
│   ├── createdAt: timestamp
│   ├── createdBy: string (userId)
│   └── results: map
└── project_distributions/{distributionId}/
    ├── name: string
    ├── project_name: string              # Auto-extracted from URL
    ├── project_url: string                # Direct download URL
    ├── extract_path: string (optional)    # Default: ~/Documents/OwletteProjects
    ├── verify_files: array (optional)     # Files to verify after extraction
    ├── targets: array                     # [{machineId, status, progress}]
    ├── status: string ('pending' | 'in_progress' | 'completed' | 'failed' | 'partial')
    ├── createdAt: timestamp
    └── completedAt: timestamp (optional)
```

---

## Web Dashboard (Client SDK)

### Initialization

**File**: `web/lib/firebase.ts`

```typescript
import { initializeApp, getApps, getApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

// Initialize Firebase (singleton pattern)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp()
export const auth = getAuth(app)
export const db = getFirestore(app)
```

### Authentication Patterns

**Email/Password Sign In**:
```typescript
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '@/lib/firebase'

async function signIn(email: string, password: string) {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password)
    return userCredential.user
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      throw new Error('No account found with this email')
    } else if (error.code === 'auth/wrong-password') {
      throw new Error('Incorrect password')
    } else {
      throw new Error('Failed to sign in')
    }
  }
}
```

**Google OAuth Sign In**:
```typescript
import { signInWithPopup, GoogleAuthProvider } from 'firebase/auth'

async function signInWithGoogle() {
  const provider = new GoogleAuthProvider()
  try {
    const userCredential = await signInWithPopup(auth, provider)
    return userCredential.user
  } catch (error) {
    throw new Error('Failed to sign in with Google')
  }
}
```

**Auth Context** (current pattern):
```typescript
// web/contexts/AuthContext.tsx
'use client'
import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, User } from 'firebase/auth'
import { auth } from '@/lib/firebase'

interface AuthContextType {
  user: User | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user)
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  const signOut = async () => {
    await auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
```

### Firestore CRUD Operations

**Read Documents**:
```typescript
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'

// Get single document
async function getMachine(siteId: string, machineId: string) {
  const docRef = doc(db, `sites/${siteId}/machines/${machineId}`)
  const docSnap = await getDoc(docRef)

  if (!docSnap.exists()) {
    throw new Error('Machine not found')
  }

  return { id: docSnap.id, ...docSnap.data() }
}

// Get collection with query
async function getOnlineMachines(siteId: string) {
  const q = query(
    collection(db, `sites/${siteId}/machines`),
    where('presence.online', '==', true)
  )

  const querySnapshot = await getDocs(q)
  return querySnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }))
}
```

**Write Documents**:
```typescript
import { doc, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'

// Create or overwrite document
async function createDeployment(deploymentId: string, data: any) {
  const docRef = doc(db, `deployments/${deploymentId}`)
  await setDoc(docRef, {
    ...data,
    createdAt: serverTimestamp(),
    status: 'pending'
  })
}

// Update existing document (merge)
async function updateDeploymentStatus(deploymentId: string, status: string) {
  const docRef = doc(db, `deployments/${deploymentId}`)
  await updateDoc(docRef, {
    status,
    updatedAt: serverTimestamp()
  })
}

// Delete document
async function deleteDeployment(deploymentId: string) {
  const docRef = doc(db, `deployments/${deploymentId}`)
  await deleteDoc(docRef)
}
```

**Real-Time Listeners**:
```typescript
import { onSnapshot, doc } from 'firebase/firestore'
import { useEffect, useState } from 'react'

// Hook for real-time document
export function useDocument<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const docRef = doc(db, path)

    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setData({ id: snapshot.id, ...snapshot.data() } as T)
        } else {
          setData(null)
        }
        setLoading(false)
      },
      (err) => {
        setError(err)
        setLoading(false)
      }
    )

    return () => unsubscribe()
  }, [path])

  return { data, loading, error }
}

// Hook for real-time collection
export function useCollection<T>(collectionPath: string) {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const colRef = collection(db, collectionPath)

    const unsubscribe = onSnapshot(
      colRef,
      (snapshot) => {
        const items = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as T[]
        setData(items)
        setLoading(false)
      },
      (err) => {
        setError(err)
        setLoading(false)
      }
    )

    return () => unsubscribe()
  }, [collectionPath])

  return { data, loading, error }
}
```

**Current Hook Pattern** (`useFirestore.ts`):
```typescript
export function useFirestore(path: string) {
  // Similar to useDocument above
  // Currently implemented in web/hooks/useFirestore.ts
}
```

### Error Handling

Always handle Firebase errors gracefully:

```typescript
import { FirebaseError } from 'firebase/app'
import { toast } from 'sonner'

async function performFirebaseOperation() {
  try {
    // ... Firestore operation
  } catch (error) {
    if (error instanceof FirebaseError) {
      switch (error.code) {
        case 'permission-denied':
          toast.error('You don\'t have permission to perform this action')
          break
        case 'not-found':
          toast.error('Resource not found')
          break
        case 'unavailable':
          toast.error('Service temporarily unavailable. Please try again.')
          break
        default:
          toast.error('An error occurred. Please try again.')
      }
      console.error('Firebase error:', error.code, error.message)
    } else {
      toast.error('An unexpected error occurred')
      console.error('Unexpected error:', error)
    }
  }
}
```

### Offline Support

Firestore caches data automatically for offline use:

```typescript
import { enableIndexedDbPersistence } from 'firebase/firestore'

// Enable offline persistence (call once at app startup)
try {
  await enableIndexedDbPersistence(db)
} catch (err) {
  if (err.code === 'failed-precondition') {
    // Multiple tabs open, persistence can only be enabled in one tab
    console.warn('Offline persistence failed: multiple tabs')
  } else if (err.code === 'unimplemented') {
    // Browser doesn't support persistence
    console.warn('Offline persistence not supported')
  }
}
```

---

## Python Agent (Admin SDK)

### Initialization

**File**: `agent/src/firebase_client.py`

```python
import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1 import Client

class FirestoreClient:
    """Handles all Firestore operations for the agent."""

    def __init__(self, credentials_path: str, site_id: str, machine_id: str):
        # Initialize Firebase Admin SDK
        if not firebase_admin._apps:
            cred = credentials.Certificate(credentials_path)
            firebase_admin.initialize_app(cred)

        self.db: Client = firestore.client()
        self.site_id = site_id
        self.machine_id = machine_id

        # Document references
        self.machine_ref = self.db.document(
            f'sites/{site_id}/machines/{machine_id}'
        )
```

### Read Operations

```python
def get_config(self) -> dict:
    """Get machine configuration from Firestore."""
    config_ref = self.db.document(
        f'config/{self.site_id}/machines/{self.machine_id}'
    )

    doc = config_ref.get()
    if not doc.exists:
        return None

    return doc.to_dict()

def get_pending_commands(self) -> list[dict]:
    """Get all pending commands for this machine."""
    commands_ref = self.db.collection(
        f'sites/{self.site_id}/machines/{self.machine_id}/commands/pending'
    )

    docs = commands_ref.stream()
    return [{'id': doc.id, **doc.to_dict()} for doc in docs]
```

### Write Operations

```python
from google.cloud import firestore

def send_heartbeat(self) -> None:
    """Send heartbeat to indicate agent is online."""
    presence_ref = self.machine_ref.collection('presence').document('current')

    presence_ref.set({
        'online': True,
        'lastHeartbeat': firestore.SERVER_TIMESTAMP,
    }, merge=True)

def update_status(self, status_data: dict) -> None:
    """Update machine status."""
    status_ref = self.machine_ref.collection('status').document('current')

    status_ref.set({
        **status_data,
        'timestamp': firestore.SERVER_TIMESTAMP
    }, merge=True)

def send_command_result(self, command_id: str, result: dict) -> None:
    """Move command from pending to completed with result."""
    # Get pending command
    pending_ref = self.db.document(
        f'sites/{self.site_id}/machines/{self.machine_id}/commands/pending/{command_id}'
    )

    command_data = pending_ref.get().to_dict()

    # Add to completed
    completed_ref = self.db.document(
        f'sites/{self.site_id}/machines/{self.machine_id}/commands/completed/{command_id}'
    )

    completed_ref.set({
        **command_data,
        'result': result,
        'completedAt': firestore.SERVER_TIMESTAMP
    })

    # Delete from pending
    pending_ref.delete()
```

### Real-Time Listeners

```python
def listen_for_commands(self, callback):
    """
    Listen for new commands from web dashboard.

    Args:
        callback: Function called when command received
                 Signature: callback(command_id: str, command_data: dict)
    """
    commands_ref = self.db.collection(
        f'sites/{self.site_id}/machines/{self.machine_id}/commands/pending'
    )

    def on_snapshot(col_snapshot, changes, read_time):
        for change in changes:
            if change.type.name == 'ADDED':
                command_id = change.document.id
                command_data = change.document.to_dict()
                callback(command_id, command_data)

    # Start listening
    watch = commands_ref.on_snapshot(on_snapshot)

    # Return watch to allow cleanup later
    return watch
```

### Error Handling

```python
from google.cloud.exceptions import GoogleCloudError
import logging

logger = logging.getLogger('owlette')

def safe_firestore_operation(operation_name: str):
    """Decorator for safe Firestore operations."""
    def decorator(func):
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except GoogleCloudError as e:
                logger.error(f"{operation_name} failed: {e}")
                # Handle specific error codes
                if e.code == 403:
                    logger.error("Permission denied - check security rules")
                elif e.code == 503:
                    logger.error("Service unavailable - will retry")
                return None
            except Exception as e:
                logger.error(f"{operation_name} unexpected error: {e}")
                return None
        return wrapper
    return decorator

@safe_firestore_operation("Send heartbeat")
def send_heartbeat(self):
    # ... implementation ...
```

---

## Security Rules

Firestore security rules control access. Example rules for Owlette:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper functions
    function isAuthenticated() {
      return request.auth != null;
    }

    function isOwner(userId) {
      return request.auth.uid == userId;
    }

    function hasSiteAccess(siteId) {
      return isAuthenticated() &&
             get(/databases/$(database)/documents/users/$(request.auth.uid))
               .data.sites.hasAny([siteId]);
    }

    // Users collection
    match /users/{userId} {
      allow read: if isAuthenticated() && isOwner(userId);
      allow write: if isAuthenticated() && isOwner(userId);
    }

    // Sites and machines
    match /sites/{siteId}/{document=**} {
      allow read: if hasSiteAccess(siteId);
      allow write: if hasSiteAccess(siteId);
    }

    // Config
    match /config/{siteId}/{document=**} {
      allow read: if hasSiteAccess(siteId);
      allow write: if hasSiteAccess(siteId);
    }

    // Deployments
    match /deployments/{deploymentId} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated();
      allow update, delete: if isAuthenticated() &&
        resource.data.createdBy == request.auth.uid;
    }
  }
}
```

**Testing Security Rules**:
Use Firebase emulator for testing rules locally before deploying.

---

## Common Patterns

### Batched Writes

For multiple related writes, use batches:

```typescript
import { writeBatch, doc } from 'firebase/firestore'

async function createMultipleMachines(siteId: string, machines: any[]) {
  const batch = writeBatch(db)

  machines.forEach(machine => {
    const docRef = doc(db, `sites/${siteId}/machines/${machine.id}`)
    batch.set(docRef, machine)
  })

  await batch.commit()
}
```

Python:
```python
def batch_update_machines(machines: list[dict]):
    batch = db.batch()

    for machine in machines:
        ref = db.document(f'sites/{site_id}/machines/{machine["id"]}')
        batch.set(ref, machine)

    batch.commit()
```

### Transactions

For read-modify-write operations:

```typescript
import { runTransaction, doc } from 'firebase/firestore'

async function incrementDeploymentCount(userId: string) {
  const userRef = doc(db, `users/${userId}`)

  await runTransaction(db, async (transaction) => {
    const userDoc = await transaction.get(userRef)

    if (!userDoc.exists()) {
      throw new Error('User not found')
    }

    const currentCount = userDoc.data().deploymentCount || 0
    transaction.update(userRef, {
      deploymentCount: currentCount + 1
    })
  })
}
```

### Pagination

For large collections:

```typescript
import { query, collection, orderBy, limit, startAfter, getDocs } from 'firebase/firestore'

async function getPaginatedMachines(siteId: string, pageSize: number, lastDoc?: any) {
  let q = query(
    collection(db, `sites/${siteId}/machines`),
    orderBy('name'),
    limit(pageSize)
  )

  if (lastDoc) {
    q = query(q, startAfter(lastDoc))
  }

  const snapshot = await getDocs(q)
  const machines = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  const lastVisible = snapshot.docs[snapshot.docs.length - 1]

  return { machines, lastVisible }
}
```

---

## Best Practices

### 1. Always Use SERVER_TIMESTAMP

```typescript
// ✅ GOOD
import { serverTimestamp } from 'firebase/firestore'

await setDoc(docRef, {
  ...data,
  createdAt: serverTimestamp()
})

// ❌ BAD
await setDoc(docRef, {
  ...data,
  createdAt: new Date()  // Client time can be wrong
})
```

### 2. Cleanup Listeners

```typescript
// ✅ GOOD
useEffect(() => {
  const unsubscribe = onSnapshot(docRef, callback)
  return () => unsubscribe()  // Cleanup!
}, [])

// ❌ BAD
useEffect(() => {
  onSnapshot(docRef, callback)  // Memory leak!
}, [])
```

### 3. Handle Offline Scenarios

```typescript
// ✅ GOOD
try {
  await updateDoc(docRef, data)
  toast.success('Updated successfully')
} catch (error) {
  if (error.code === 'unavailable') {
    toast.warning('Offline - changes will sync when online')
  } else {
    toast.error('Update failed')
  }
}
```

### 4. Validate Data

```typescript
// ✅ GOOD
import { validateEmail } from '@/lib/validators'

if (!validateEmail(email)) {
  throw new Error('Invalid email')
}

await createUser({ email, ... })

// ❌ BAD - trusting user input
await createUser({ email, ... })  // What if email is malformed?
```

### 5. Use Proper Types

```typescript
// ✅ GOOD
interface Machine {
  id: string
  name: string
  presence: {
    online: boolean
    lastHeartbeat: Timestamp
  }
}

const machine = await getMachine(id) as Machine

// ❌ BAD
const machine: any = await getMachine(id)
```

---

## Debugging

### Enable Logging (Web)

```typescript
import { setLogLevel } from 'firebase/firestore'

// In development only
if (process.env.NODE_ENV === 'development') {
  setLogLevel('debug')
}
```

### Enable Logging (Python)

```python
import logging

# Set Firebase logger to DEBUG
logging.getLogger('google.cloud').setLevel(logging.DEBUG)
```

### Common Issues

**Permission Denied**:
- Check Firestore security rules
- Verify user is authenticated
- Confirm user has site access

**Offline/Unavailable**:
- Check internet connection
- Verify Firebase project status
- Check if persistence is enabled

**Listener Not Triggering**:
- Verify listener is active (not unsubscribed)
- Check if document/collection actually changed
- Confirm security rules allow read access

---

---

## Project Distribution Patterns

### Creating a Distribution

```typescript
import { setDoc, doc } from 'firebase/firestore'

async function createProjectDistribution(
  siteId: string,
  distributionData: {
    name: string
    project_url: string
    extract_path?: string
    verify_files?: string[]
  },
  machineIds: string[]
) {
  const distributionId = `project-dist-${Date.now()}`
  const distributionRef = doc(db, 'sites', siteId, 'project_distributions', distributionId)

  // Auto-extract project filename from URL
  const url = new URL(distributionData.project_url)
  const projectName = url.pathname.substring(url.pathname.lastIndexOf('/') + 1) || 'project.zip'

  // Initialize targets with pending status
  const targets = machineIds.map(machineId => ({
    machineId,
    status: 'pending'
  }))

  // Create distribution document
  await setDoc(distributionRef, {
    ...distributionData,
    project_name: projectName,
    targets,
    createdAt: serverTimestamp(),
    status: 'pending'
  })

  // Send distribute_project command to each machine
  const commandPromises = machineIds.map(async (machineId) => {
    const commandId = `distribute_${distributionId.replace(/-/g, '_')}_${machineId.replace(/-/g, '_')}_${Date.now()}`
    const commandRef = doc(db, 'sites', siteId, 'machines', machineId, 'commands', 'pending')

    await setDoc(commandRef, {
      [commandId]: {
        type: 'distribute_project',
        project_url: distributionData.project_url,
        project_name: projectName,
        extract_path: distributionData.extract_path,
        verify_files: distributionData.verify_files,
        distribution_id: distributionId,
        timestamp: Date.now(),
        status: 'pending'
      }
    }, { merge: true })
  })

  await Promise.all(commandPromises)

  // Update distribution status to in_progress
  await setDoc(distributionRef, { status: 'in_progress' }, { merge: true })

  return distributionId
}
```

### Listening for Distribution Progress

```typescript
import { onSnapshot, doc } from 'firebase/firestore'

function useDistributionProgress(siteId: string, distributionId: string) {
  const [distribution, setDistribution] = useState(null)

  useEffect(() => {
    const distributionRef = doc(db, 'sites', siteId, 'project_distributions', distributionId)

    const unsubscribe = onSnapshot(distributionRef, (snapshot) => {
      if (snapshot.exists()) {
        setDistribution({ id: snapshot.id, ...snapshot.data() })
      }
    })

    return () => unsubscribe()
  }, [siteId, distributionId])

  return distribution
}
```

### Agent: Reporting Distribution Progress

```python
from google.cloud import firestore

def update_distribution_progress(
    self,
    command_id: str,
    status: str,  # 'downloading', 'extracting', 'completed', 'failed'
    distribution_id: str,
    progress: int = None
):
    """Update distribution progress in Firestore."""
    completed_ref = self.db.document(
        f'sites/{self.site_id}/machines/{self.machine_id}/commands/completed'
    )

    update_data = {
        command_id: {
            'status': status,
            'distribution_id': distribution_id,
            'timestamp': firestore.SERVER_TIMESTAMP
        }
    }

    if progress is not None:
        update_data[command_id]['progress'] = progress

    completed_ref.set(update_data, merge=True)
```

---

## Resources

For more detailed Firebase patterns:
- [Firebase Documentation](https://firebase.google.com/docs)
- [Firestore Best Practices](https://firebase.google.com/docs/firestore/best-practices)
- Owlette docs: `docs/firebase-setup.md`
- Owlette docs: `docs/deployment.md`
- Owlette docs: `docs/project-distribution.md`

---

## When This Skill Activates

This skill automatically activates when:

- Working on files with Firebase imports
- Prompt contains keywords: "firebase", "firestore", "auth", "authentication", "real-time"
- Files contain patterns: `import.*firebase`, `firestore\.`, `onSnapshot`, `firebase_admin`

---

**Version**: 1.0.0
**Last Updated**: 2025-01-31
