import {
  FerrisWheel,
  Monitor,
  Landmark,
  Music,
  Building2,
  Church,
  Clapperboard,
  Lightbulb,
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
    label: 'projector walls',
    tagline: 'keep multi-projector mappings aligned across long shows',
    icon: Monitor,
  },
  {
    label: 'LED installations',
    tagline: 'monitor every LED processor and content node from one place',
    icon: Lightbulb,
  },
];

export function FeatureGrid() {
  return (
    <section className="py-16 sm:py-24 px-4 sm:px-6">
      <div className="max-w-4xl mx-auto text-center">
        <p className="text-sm sm:text-base text-muted-foreground mb-6">
          built for
        </p>
        <div className="flex flex-wrap justify-center gap-x-3 sm:gap-x-4 gap-y-2">
          {verticals.map(({ label, icon: Icon }, i) => (
            <span key={label} className="flex items-center gap-3 sm:gap-4">
              <span className="flex items-center gap-1.5 sm:gap-2 cursor-default">
                <Icon className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-muted-foreground/50" />
                <span className="text-lg sm:text-2xl font-heading font-semibold text-foreground/80">
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
      </div>
    </section>
  );
}
