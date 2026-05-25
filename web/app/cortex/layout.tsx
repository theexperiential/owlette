'use client';

/**
 * Persistent Cortex shell.
 *
 * `/cortex` and `/cortex/[chatId]` are separate route segments. Without a shared
 * layout, navigating between them remounts the page subtree and wipes all of
 * CortexChatView's local UI state (sidebar collapse, category collapse, the
 * optimistic "new conversation" row). Hoisting the view into this layout keeps a
 * single instance alive across those navigations; the active chat id is derived
 * from the pathname and handed down as `initialChatId`. The page files render
 * nothing — they exist only so the routes resolve.
 */

import { usePathname } from 'next/navigation';
import { CortexChatView } from './components/CortexChatView';

export default function CortexLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const match = pathname?.match(/^\/cortex\/(.+)$/);
  const initialChatId = match ? decodeURIComponent(match[1]) : undefined;

  return (
    <>
      {children}
      <CortexChatView initialChatId={initialChatId} />
    </>
  );
}
