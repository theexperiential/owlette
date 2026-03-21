'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { OwletteEyeIcon } from './OwletteEye';

export function LandingHeader() {
  const { user, loading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close menu on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    if (menuOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  const scrollToTop = (e: React.MouseEvent) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setMenuOpen(false);
  };

  return (
    <header className="fixed top-0 inset-x-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-md">
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <a href="#" onClick={scrollToTop} className="flex items-center gap-1.5 group cursor-pointer">
          <OwletteEyeIcon size={28} className="group-hover:scale-105 transition-transform translate-y-[1px]" />
          <span className="text-lg sm:text-xl font-semibold tracking-tight translate-y-[1px]">owlette</span>
        </a>

        {/* Right side */}
        <div className="flex items-center gap-2 sm:gap-3">
          {loading ? (
            <div className="w-20 h-9 bg-muted animate-pulse rounded-md" />
          ) : user ? (
            <Button asChild variant="default" size="sm" className="bg-accent-cyan hover:bg-accent-cyan-hover text-background font-medium">
              <Link href="/dashboard">dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex text-muted-foreground hover:text-foreground">
                <Link href="/login">sign in</Link>
              </Button>
              <Button asChild size="sm" className="bg-accent-cyan hover:bg-accent-cyan-hover text-background font-medium">
                <Link href="/register">get started</Link>
              </Button>
            </>
          )}

          {/* Hamburger - mobile */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden p-2 -mr-2 text-foreground hover:text-accent-cyan transition-colors"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div
          className="fixed inset-0 top-16 bg-background md:hidden z-40 animate-in fade-in slide-in-from-top-2 duration-200"
          onClick={() => setMenuOpen(false)}
        >
          <nav className="flex flex-col items-center gap-8 pt-12 px-6" onClick={(e) => e.stopPropagation()}>
            {!loading && !user && (
              <div className="flex flex-col gap-4 w-full max-w-xs">
                <Button asChild variant="outline" size="lg" className="w-full">
                  <Link href="/login" onClick={() => setMenuOpen(false)}>Sign In</Link>
                </Button>
                <Button asChild size="lg" className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-background font-medium">
                  <Link href="/register" onClick={() => setMenuOpen(false)}>Get Started</Link>
                </Button>
              </div>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
