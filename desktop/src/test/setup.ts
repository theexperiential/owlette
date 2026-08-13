import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// React Testing Library only self-registers its cleanup when it finds a global
// `afterEach`. Wiring it explicitly keeps tests isolated from each other
// regardless of the `globals` setting in vite.config.ts.
afterEach(cleanup)

// jsdom ships no `matchMedia`, and the day-pill selector asks it whether the
// pointer is fine before deciding between drag-select and plain clicks. Left
// missing, the ported component would throw on render here while working in the
// webview; answering `true` makes tests take the same branch the app does.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('pointer: fine'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}
