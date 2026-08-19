'use client';

/**
 * Persistent Hoot shell.
 *
 * `/hoot` and `/hoot/[chatId]` are separate route segments. Without a shared
 * layout, navigating between them remounts the page subtree and wipes all of
 * HootChatView's local UI state (sidebar collapse, category collapse, the
 * optimistic "new conversation" row). Hoisting the view into this layout keeps a
 * single instance alive across those navigations; the active chat id is derived
 * from the pathname and handed down as `initialChatId`. The page files render
 * nothing — they exist only so the routes resolve.
 */

import { usePathname } from 'next/navigation';
import { HootChatView } from './components/HootChatView';

export default function HootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const match = pathname?.match(/^\/hoot\/(.+)$/);
  const initialChatId = match ? decodeURIComponent(match[1]) : undefined;

  return (
    <>
      {children}
      <HootChatView initialChatId={initialChatId} />
    </>
  );
}
