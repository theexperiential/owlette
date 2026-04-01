'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { OwletteEyeIcon } from './OwletteEye';

export function LandingHeader() {
  const scrollToTop = (e: React.MouseEvent) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
            <Link href="/download">download</Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
            <Link href="/login">sign in</Link>
          </Button>
          <Button asChild size="sm" className="bg-accent-cyan hover:bg-accent-cyan-hover text-background font-medium">
            <Link href="/register">get started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
