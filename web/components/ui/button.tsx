import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "btn-sweep inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring/30 focus-visible:ring-ring/20 focus-visible:ring-1 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // No `hover:bg-*` on these variants: the .btn-sweep scrim (globals.css)
        // supplies the hover feedback as an L→R sweep over the resting fill. A
        // hover:bg here would cross-fade the base colour underneath the sweep
        // and muddy it. Text/border hover states stay as ordinary utilities and
        // transition alongside.
        default: "bg-primary text-primary-foreground",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        // Dark outline previously used `dark:border-input` (--input, L≈0.25)
        // against a --card surface (L≈0.23) — a 0.02 delta, i.e. no visible
        // edge — over a 30%-opacity fill. The result read as a stray
        // background rather than a control. It now takes the real --border
        // (L≈0.35, inherited from the base `* { border-border }` by simply not
        // overriding it) and a full-strength --input fill, so the edge is what
        // identifies it as a button.
        outline:
          "border bg-background shadow-xs hover:text-secondary-foreground dark:bg-input dark:hover:text-secondary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        ghost: "hover:text-secondary-foreground",
        // link opts out of the button sweep — .hl-link gives it the
        // glyph-accurate text highlight instead.
        link: "hl-link text-primary",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
