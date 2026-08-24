'use client';

/**
 * Right-slide sheet for the mobile roost detail view. Wraps
 * `@radix-ui/react-dialog` directly, NOT `@/components/ui/dialog` — that
 * `DialogContent` is centred-modal styled and fights the slide layout.
 * Animations come from `tw-animate-css` (imported in `globals.css`);
 * esc/overlay close are inherited from Radix.
 *
 * No close button: the caller's header inside `children` owns the X.
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
