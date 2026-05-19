'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { InteractiveBackground } from './InteractiveBackground';
import { OwletteEye } from './OwletteEye';
import { RotatingWord } from './RotatingWord';

const prefixWords = ['monitor', 'deploy software to', 'ask questions to', 'remotely control', 'manage', 'script', 'lay out displays on', 'diagnose'];
const suffixWords = [
  'computers',
  'media servers',
  'interactive installations',
  'interactive exhibits',
  'kiosks',
  'digital signage',
  'TouchDesigner PCs',
  'Unreal Engine nodes',
  'Node.js servers',
  'projector walls',
  'LED arrays',
  'video walls',
];

export function HeroSection() {
  return (
    <section className="relative sm:h-[100dvh] flex flex-col pt-16 overflow-hidden">
      {/* Interactive mouse-reactive background */}
      <InteractiveBackground />

      {/* Content wrapper — headline pinned to vertical center, eye grows upward, CTA grows downward */}
      <div className="relative z-10 w-full max-w-5xl mx-auto px-4 sm:px-6 text-center flex flex-col items-center flex-1 justify-center py-12 sm:py-0 sm:-mt-[18vh]">
        {/* The Eye */}
        <div className="relative flex items-center justify-center mb-6 sm:mb-8">
          <div
            className="absolute w-[300px] h-[300px] sm:w-[500px] sm:h-[500px] rounded-full blur-3xl"
            style={{
              background: 'radial-gradient(circle, oklch(0.70 0.14 30 / 0.15) 0%, oklch(0.72 0.16 55 / 0.08) 40%, transparent 70%)',
            }}
          />
          <OwletteEye
            size={220}
            className="sm:w-[320px] sm:h-[320px] drop-shadow-2xl relative z-10"
            animated
          />
        </div>

        {/* Headline */}
        <h1 className="hero-headline text-foreground mb-4 sm:mb-6 hero-enter">
          attention<br className="sm:hidden" /> is all you need
        </h1>

        {/* Subheadline */}
        <p className="hero-subheadline max-w-5xl mx-auto mb-8 sm:mb-10 h-[4.5em] sm:h-[3em] flex items-center justify-center overflow-hidden hero-enter-delay-1">
          <span className="text-center">
            <RotatingWord words={prefixWords} align="end" direction="up" />{' '}
            all of your{' '}
            <RotatingWord words={suffixWords} align="start" direction="down" delay={2000} />
          </span>
        </p>

        {/* CTA */}
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center hero-enter-delay-2">
          <Button asChild size="lg" className="bg-accent-cyan hover:bg-accent-cyan-hover text-background font-semibold px-8 h-12 text-base">
            <Link href="/register">get started</Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="border-border/50 hover:bg-accent-warm/10 hover:border-accent-warm/30 h-12 text-base text-muted-foreground">
            <Link href="/demo" target="_blank">see the live demo</Link>
          </Button>
        </div>

        {/* Platform pill row */}
        <p className="mt-6 sm:mt-8 text-xs sm:text-sm text-muted-foreground text-center hero-enter-delay-3">
          windows only <span className="mx-1 sm:mx-2">&middot;</span> free during beta <span className="mx-1 sm:mx-2">&middot;</span>
          <a
            href="https://github.com/theexperiential/owlette/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            FSL-1.1 source on github
          </a>
        </p>
      </div>

    </section>
  );
}
