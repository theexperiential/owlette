'use client';

/**
 * RoostMobileSheet — right-slide sheet primitive for the mobile roost detail
 * view (wave 1.2).
 *
 * Thin wrapper around `@radix-ui/react-dialog` primitives (intentionally NOT
 * `@/components/ui/dialog`, whose `DialogContent` is centred-modal styled and
 * would fight the right-slide layout). Slide + fade animations come from the
 * `tw-animate-css` utilities wired up via `@import "tw-animate-css"` in
 * `globals.css`. Esc-to-close and overlay-click-to-close are inherited from
 * the Radix primitives.
 *
 * No visible close button — callers wrap their own header (e.g.
 * `RoostDetailPanel`) inside `children`, and that header owns the close X.
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';

interface RoostMobileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
}

export function RoostMobileSheet({
  open,
  onOpenChange,
  title,
  children,
}: RoostMobileSheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-background border-l border-border shadow-xl flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right">
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default RoostMobileSheet;
