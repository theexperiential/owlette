'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/contexts/AuthContext';
import { OwletteEyeIcon } from './OwletteEye';

type NavLinkDef = { label: string; href: string; external?: boolean; prefetch?: boolean };

// Section anchors, in page order.
const SECTION_LINKS: NavLinkDef[] = [
  { label: 'capabilities', href: '#capabilities' },
  { label: 'pricing', href: '#pricing' },
  { label: 'faq', href: '#faq' },
];

// External / product links, shown to everyone.
const UTIL_LINKS: NavLinkDef[] = [
  { label: 'docs', href: '/docs' },
  { label: 'download', href: '/download', prefetch: false },
];

// Appended only while signed out — offering "sign in" to a signed-in visitor is
// the thing this header used to get wrong.
const SIGN_IN_LINK: NavLinkDef = { label: 'sign in', href: '/login' };

function linkEl(link: NavLinkDef, className?: string, onClick?: () => void) {
  if (link.external) {
    return (
      <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className={className} onClick={onClick}>
        {link.label}
      </a>
    );
  }
  if (link.href.startsWith('#')) {
    return (
      <a key={link.label} href={link.href} className={className} onClick={onClick}>
        {link.label}
      </a>
    );
  }
  return (
    <Link key={link.label} href={link.href} prefetch={link.prefetch} className={className} onClick={onClick}>
      {link.label}
    </Link>
  );
}

export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  const { user, loading } = useAuth();

  /**
   * Signed-out markup is what the server renders and what most visitors get, so
   * it stands until auth resolves. A skeleton in its place would pulse the
   * header on every cold load of a public page to spare a returning user one
   * frame — the wrong trade on the highest-traffic page in the app.
   */
  const signedIn = !loading && !!user;
  const utilLinks = signedIn ? UTIL_LINKS : [...UTIL_LINKS, SIGN_IN_LINK];

  const scrollToTop = (e: React.MouseEvent) => {
    e.preventDefault();
    close();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const ghostClass = 'text-muted-foreground hover:text-foreground px-2';

  return (
    <header className="fixed top-0 inset-x-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-md hero-enter-nav">
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <a href="#" onClick={scrollToTop} className="flex items-center gap-1.5 group cursor-pointer">
          <OwletteEyeIcon size={28} className="group-hover:scale-105 transition-transform translate-y-[1px]" />
          <span className="text-lg sm:text-xl font-semibold tracking-tight translate-y-[1px]">owlette</span>
        </a>

        {/* Desktop nav */}
        <div className="hidden lg:flex items-center gap-0.5">
          {SECTION_LINKS.map((link) => (
            <Button key={link.label} asChild variant="ghost" size="sm" className={ghostClass}>
              {linkEl(link)}
            </Button>
          ))}
          <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
          {utilLinks.map((link) => (
            <Button key={link.label} asChild variant="ghost" size="sm" className={ghostClass}>
              {linkEl(link)}
            </Button>
          ))}
          {signedIn ? (
            <>
              <Button asChild size="sm" className="ml-1.5 text-background font-medium">
                <Link href="/dashboard">go to dashboard</Link>
              </Button>
              <span className="ml-2 flex items-center" title={user?.email ?? undefined}>
                <UserAvatar user={user} size="sm" />
              </span>
            </>
          ) : (
            <Button asChild size="sm" className="ml-1.5 text-background font-medium">
              <Link href="/register">get started</Link>
            </Button>
          )}
        </div>

        {/* Mobile / tablet: get started + hamburger */}
        <div className="flex lg:hidden items-center gap-2">
          {/* Shorter label than desktop: it shares the row with the hamburger. */}
          <Button asChild size="sm" className="text-background font-medium">
            <Link href={signedIn ? '/dashboard' : '/register'}>
              {signedIn ? 'dashboard' : 'get started'}
            </Link>
          </Button>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'close menu' : 'open menu'}
            aria-expanded={menuOpen}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile menu panel — slides open/closed via a grid-rows transition */}
      <div
        aria-hidden={!menuOpen}
        className={`lg:hidden grid overflow-hidden bg-background/95 backdrop-blur-md transition-[grid-template-rows] duration-200 ease-out ${
          menuOpen ? 'grid-rows-[1fr] border-t border-border/50' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <nav className="w-full max-w-5xl mx-auto px-4 sm:px-6 py-2 flex flex-col">
            {SECTION_LINKS.map((link) =>
              linkEl(link, 'py-3 text-base text-muted-foreground hover:text-foreground transition-colors', close),
            )}
            <span aria-hidden className="my-1 h-px w-full bg-border/50" />
            {utilLinks.map((link) =>
              linkEl(link, 'py-3 text-base text-muted-foreground hover:text-foreground transition-colors', close),
            )}
            {signedIn && user && (
              <div className="flex items-center gap-2.5 py-3 text-base text-muted-foreground">
                <UserAvatar user={user} size="sm" />
                <span className="truncate">{user.displayName || user.email}</span>
              </div>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
}
