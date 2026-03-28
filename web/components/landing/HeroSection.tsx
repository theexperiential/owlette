'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { InteractiveBackground } from './InteractiveBackground';
import { OwletteEye } from './OwletteEye';
import { RotatingWord } from './RotatingWord';

const prefixWords = ['monitor', 'deploy software to', 'ask questions to', 'take a vacation from', 'remotely control'];
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
];

/** Fisher-Yates shuffle (returns new array) */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function HeroSection() {
  const [shuffledPrefixes] = useState(() => shuffle(prefixWords));
  const [shuffledSuffixes] = useState(() => shuffle(suffixWords));

  return (
    <section className="relative h-[100dvh] flex flex-col pt-16 overflow-hidden">
      {/* Interactive mouse-reactive background */}
      <InteractiveBackground />

      {/* Content wrapper — headline pinned to vertical center, eye grows upward, CTA grows downward */}
      <div className="relative z-10 w-full max-w-5xl mx-auto px-4 sm:px-6 text-center flex flex-col items-center flex-1 justify-center -mt-[10vh]">
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
        <h1 className="hero-headline text-foreground mb-4 sm:mb-6 animate-in fade-in slide-in-from-bottom-4 duration-1000">
          attention is all you need
        </h1>

        {/* Subheadline */}
        <p className="hero-subheadline max-w-5xl mx-auto mb-8 sm:mb-10 min-h-[4.5em] flex items-start justify-center animate-in fade-in slide-in-from-bottom-6 duration-1000 delay-200">
          <span className="text-center">
            <RotatingWord words={shuffledPrefixes} align="end" direction="up" />{' '}
            all of your{' '}
            <RotatingWord words={shuffledSuffixes} align="start" direction="down" delay={2000} />.
          </span>
        </p>

        {/* CTA */}
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center animate-in fade-in slide-in-from-bottom-6 duration-1000 delay-300">
          <Button asChild size="lg" className="bg-accent-cyan hover:bg-accent-cyan-hover text-background font-semibold px-8 h-12 text-base">
            <Link href="/register">get started</Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="border-border/50 hover:bg-accent-warm/10 hover:border-accent-warm/30 h-12 text-base text-muted-foreground">
            <Link href="/login">sign in</Link>
          </Button>
        </div>
      </div>

    </section>
  );
}
