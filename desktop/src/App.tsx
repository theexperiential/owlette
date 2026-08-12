import { getVersion } from '@tauri-apps/api/app'
import { Rocket, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { OwletteEye } from '@/components/landing/OwletteEye'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Toaster } from '@/components/ui/sonner'
import { MENU_SURFACE } from '@/lib/surfaces'
import { toast } from 'sonner'

/**
 * Design-system shakedown screen.
 *
 * This is scaffolding, not product: it exercises the pieces ported out of
 * `web/` so a regression in the port is visible the moment the window opens —
 * the dark token palette, Geist sans + mono, the `.btn-sweep` hover on every
 * button variant, the `.hl-link` glyph sweep on the `link` variant, a Radix
 * portal (dropdown) wearing MENU_SURFACE, and sonner toasts.
 */
function App() {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    // Proves the Tauri IPC bridge is live. In a browser (vitest, `npm run dev`
    // without tauri) there is no bridge, so this rejects and we simply show
    // nothing rather than blanking the screen.
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null))
  }, [])

  return (
    <main className="min-h-screen px-8 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="flex items-center gap-4">
          <OwletteEye size={56} animated />
          <div className="flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">owlette</h1>
            <p className="text-sm text-muted-foreground">
              desktop shell — design system ported from the web app
            </p>
          </div>
          {version && <Badge variant="secondary">v{version}</Badge>}
        </header>

        <Card>
          <CardHeader>
            <CardTitle>buttons</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button onClick={() => toast.success('design system is live')}>
              default
            </Button>
            <Button variant="secondary">secondary</Button>
            <Button variant="outline">outline</Button>
            <Button variant="ghost">ghost</Button>
            <Button variant="destructive">destructive</Button>
            {/* KNOWN ISSUE, inherited verbatim from web/ — this renders as an
                invisible button. The cva base applies `btn-sweep` to every
                variant and `link` adds `hl-link`. In globals.css the `.hl-link`
                @supports block paints the glyphs from a 3-layer background and
                sets `color: transparent`; `.btn-sweep` comes later in the same
                unlayered stylesheet at equal specificity, so its single-layer
                scrim replaces those layers, `background-clip: text` truncates to
                it, and at rest its size is 0% — nothing is painted. Left in
                place deliberately so the defect stays visible; fixing it means
                changing web/components/ui/button.tsx (or the rule order in
                web/app/globals.css), which is out of scope for the port. */}
            <Button variant="link">link</Button>
            <Button size="icon-sm" variant="outline" aria-label="settings">
              <Settings />
            </Button>
            <Button size="icon-lg" variant="outline" aria-label="deploy">
              <Rocket />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>type &amp; fields</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm">
              geist sans — the quick brown fox jumps over the lazy dog 0123456789
            </p>
            <p className="font-mono text-sm text-muted-foreground">
              geist mono — C:\ProgramData\Owlette\agent\src 0123456789
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="machine">machine name</Label>
              <Input id="machine" placeholder="studio-wall-01" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>menu surface</CardTitle>
          </CardHeader>
          <CardContent>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">open menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={`${MENU_SURFACE} w-56`}>
                <DropdownMenuItem>dashboard</DropdownMenuItem>
                <DropdownMenuItem>roost</DropdownMenuItem>
                <DropdownMenuItem>settings</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardContent>
        </Card>
      </div>

      <Toaster />
    </main>
  )
}

export default App
