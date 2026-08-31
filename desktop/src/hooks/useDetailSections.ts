import { useCallback, useEffect, useRef, useState } from 'react'
import {
  detailSections,
  setDetailSection,
  type DetailSectionKey,
  type DetailSections,
} from '@/lib/ipc'

/**
 * What each disclosure does before any preference is stored: the everyday
 * sections open, the tune-once "how to run" folded. Mirrors the host defaults.
 */
export const DETAIL_SECTION_DEFAULTS: DetailSections = {
  whatToRun: true,
  whenToRun: true,
  howToRun: false,
}

export interface DetailSectionsHandle {
  sections: DetailSections
  /** Apply one section's open state now, persist it for next launch. */
  toggle: (section: DetailSectionKey, open: boolean) => void
}

/**
 * Remembered open state of the detail pane's three disclosures. Same shape as
 * `useSidebarLayout`: read once at mount, written on every toggle (a discrete
 * click, so no debounce), and applied locally whether or not the write lands.
 */
export function useDetailSections(): DetailSectionsHandle {
  const [sections, setSections] = useState<DetailSections>(DETAIL_SECTION_DEFAULTS)
  /** True once the operator has toggled; stops a slow read from landing on
   *  top of a preference they have already changed. */
  const touched = useRef(false)

  useEffect(() => {
    let disposed = false
    void detailSections()
      .then((stored) => {
        if (!disposed && !touched.current) setSections(stored)
      })
      .catch(() => {
        // No bridge (browser dev run), or an unreadable file — the defaults stand.
      })
    return () => {
      disposed = true
    }
  }, [])

  const toggle = useCallback((section: DetailSectionKey, open: boolean) => {
    touched.current = true
    setSections((current) => ({ ...current, [section]: open }))
    // The preference still applies this session if the write fails.
    void setDetailSection(section, open).catch(() => {})
  }, [])

  return { sections, toggle }
}
