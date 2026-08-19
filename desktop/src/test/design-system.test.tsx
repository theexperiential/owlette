import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MENU_SURFACE } from '@/lib/surfaces'
// `?raw` hands back the authored stylesheet untransformed, which is what these
// assertions are about — the port, not Tailwind's compiled output.
import globalsCss from '@/globals.css?raw'

/**
 * Smoke test for the design system ported out of `web/`.
 *
 * It is deliberately about the SEAMS of the port rather than about component
 * behaviour: that the `@` alias resolves the verbatim copies, that
 * cn()/cva()/tailwind-merge are wired together, that the hand-customised bits
 * of button.tsx survived, and that the unlayered rules globals.css depends on
 * are still in the stylesheet (and the stripped blocks are still stripped).
 */

describe('cn', () => {
  it('merges conditional classes and lets the last tailwind utility win', () => {
    const hidden = false
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('text-sm', hidden && 'hidden', undefined, 'font-medium')).toBe(
      'text-sm font-medium',
    )
  })
})

describe('Button', () => {
  it('renders through the @ alias and carries the btn-sweep hover base', () => {
    render(<Button>deploy</Button>)

    const button = screen.getByRole('button', { name: 'deploy' })
    expect(button.className).toContain('btn-sweep')
    expect(button.className).toContain('bg-primary')
  })

  it('keeps the owlette customisations: no hover:bg-*, extra icon sizes', () => {
    const { container } = render(
      <>
        <Button variant="default">a</Button>
        <Button variant="secondary">b</Button>
        <Button size="icon-sm" aria-label="c" />
        <Button size="icon-lg" aria-label="d" />
        <Button variant="link">e</Button>
      </>,
    )

    const classes = [...container.querySelectorAll('button')].map(
      (el) => el.className,
    )

    // The .btn-sweep scrim supplies hover feedback; a hover:bg-* would
    // cross-fade the base colour underneath it and muddy the sweep.
    expect(classes.join(' ')).not.toMatch(/hover:bg-/)
    expect(classes[2]).toContain('size-8')
    expect(classes[3]).toContain('size-10')
    // link opts into the glyph-accurate text highlight instead.
    expect(classes[4]).toContain('hl-link')
  })
})

describe('globals.css port', () => {
  it('keeps the unlayered interaction rules the components depend on', () => {
    for (const rule of ['.btn-sweep {', '.hl-link {', '.form-reveal {']) {
      expect(globalsCss).toContain(rule)
    }
    // Unlayered on purpose: they must outrank Tailwind's utilities layer.
    expect(globalsCss).not.toMatch(/@layer\s+utilities\s*{[^}]*btn-sweep/)
  })

  it('binds the self-hosted Geist faces to the load-bearing variable names', () => {
    expect(globalsCss).toContain('--font-geist:')
    expect(globalsCss).toContain('--font-geist-mono:')
    expect(globalsCss).toContain('--font-sans: var(--font-geist)')
    expect(globalsCss).toContain('--font-mono: var(--font-geist-mono)')
    expect(globalsCss).toContain('assets/fonts/Geist-Variable.woff2')
    expect(globalsCss).toContain('assets/fonts/GeistMono-Variable.woff2')
  })

  it('leaves out the web-only blocks that were stripped during the port', () => {
    for (const stripped of [
      '.hoot-markdown',
      '.machines-grid',
      '.site-row-cv',
      '@keyframes hero-enter',
    ]) {
      expect(globalsCss).not.toContain(stripped)
    }
  })
})

describe('MENU_SURFACE', () => {
  it('matches the web recipe verbatim', () => {
    expect(MENU_SURFACE).toBe(
      'border-border bg-secondary/85 backdrop-blur-sm shadow-2xl shadow-black/50 ring-1 ring-white/10',
    )
  })
})
