import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// React Testing Library only self-registers its cleanup when it finds a global
// `afterEach`. Wiring it explicitly keeps tests isolated from each other
// regardless of the `globals` setting in vite.config.ts.
afterEach(cleanup)
