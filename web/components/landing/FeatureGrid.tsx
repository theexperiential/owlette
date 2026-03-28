'use client';

import { useState } from 'react';
import {
  FerrisWheel,
  Monitor,
  Landmark,
  Music,
  Building2,
  Church,
  Clapperboard,
  Store,
  type LucideIcon,
} from 'lucide-react';

interface Vertical {
  label: string;
  tagline: string;
  icon: LucideIcon;
}

const verticals: Vertical[] = [
  {
    label: 'theme parks',
    tagline: 'keep every ride, queue, and show running 24/7',
    icon: FerrisWheel,
  },
  {
    label: 'digital signage',
    tagline: 'keep every screen on and up to date',
    icon: Monitor,
  },
  {
    label: 'museums & galleries',
    tagline: 'catch and resolve software crashes before doors open',
    icon: Landmark,
  },
  {
    label: 'live events',
    tagline: 'manage multi-machine clusters under pressure',
    icon: Music,
  },
  {
    label: 'corporate AV',
    tagline: 'maintain lobby displays and experience centers remotely',
    icon: Building2,
  },
  {
    label: 'worship',
    tagline: 'keep services running without a tech in the booth',
    icon: Church,
  },
  {
    label: 'virtual production',
    tagline: 'monitor real-time rendering performance over time on XR stages',
    icon: Clapperboard,
  },
  {
    label: 'experiential retail',
    tagline: 'manage in-store installations across every flagship',
    icon: Store,
  },
];

export function FeatureGrid() {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  return (
    <section className="py-16 sm:py-24 px-4 sm:px-6">
      <div className="max-w-4xl mx-auto text-center">
        <p className="text-sm sm:text-base text-muted-foreground mb-6">
          built for
        </p>
        <div className="flex flex-wrap justify-center gap-x-3 sm:gap-x-4 gap-y-2">
          {verticals.map(({ label, icon: Icon }, i) => (
            <span
              key={label}
              className="flex items-center gap-3 sm:gap-4"
              onMouseEnter={() => setActiveIndex(i)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <span className="flex items-center gap-1.5 sm:gap-2 cursor-default">
                <Icon
                  className={`w-4 h-4 sm:w-[18px] sm:h-[18px] transition-colors duration-200 ${
                    activeIndex === i
                      ? 'text-accent-warm'
                      : 'text-muted-foreground/50'
                  }`}
                />
                <span
                  className={`text-lg sm:text-2xl font-heading font-semibold transition-colors duration-200 ${
                    activeIndex === i
                      ? 'text-accent-warm'
                      : 'text-foreground/80'
                  }`}
                >
                  {label}
                </span>
              </span>
              {i < verticals.length - 1 && (
                <span className="text-accent-warm/40 text-lg select-none">
                  /
                </span>
              )}
            </span>
          ))}
        </div>
        <div className="h-8 mt-4 flex items-center justify-center">
          <p
            className={`text-base sm:text-lg text-muted-foreground transition-all duration-200 ${
              activeIndex !== null
                ? 'opacity-100 translate-y-0'
                : 'opacity-0 translate-y-1'
            }`}
          >
            {activeIndex !== null ? verticals[activeIndex].tagline : ''}
          </p>
        </div>
      </div>
    </section>
  );
}
