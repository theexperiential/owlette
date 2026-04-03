import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Check } from 'lucide-react';

const included = [
  { label: 'real-time machine monitoring' },
  { label: 'process control & auto-recovery' },
  { label: 'email & webhook notifications' },
  { label: 'software & file deployment' },
  { label: 'process scheduling & automatic reboots' },
  { label: 'remote screenshots' },
  { label: 'multi-site organization' },
  { label: 'unlimited log history' },
  { label: 'cortex AI fleet assistant', asterisk: true },
];

export function PricingSection() {
  return (
    <section id="pricing" className="pt-16 sm:pt-24 pb-32 sm:pb-48 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="section-headline text-foreground mb-4">
          simple, per-machine pricing.
        </h2>
        <p className="section-subheadline mb-10">
          no tiers, no seats, no hidden fees. pay only for what you run.
        </p>

        {/* Card */}
        <div className="relative rounded-2xl border border-border bg-card/60 px-6 sm:px-12 text-center">
          {/* Price */}
          <div className="py-8">
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-1 opacity-35">
              <span className="text-5xl sm:text-6xl font-heading font-bold text-foreground line-through decoration-2">
                $10
              </span>
              <span className="text-lg sm:text-xl">
                /machine/month
              </span>
            </div>
            <p className="text-accent-warm font-semibold text-xl">
              free during beta
            </p>
          </div>

          <hr className="border-border/50" />

          {/* Features */}
          <div className="py-8">
            <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-4 text-left mb-4">
              {included.map(({ label, asterisk }) => (
                <li key={label} className="flex items-center gap-2.5 text-base sm:text-lg text-foreground/80 text-pretty">
                  <Check className="w-4 h-4 text-accent-cyan shrink-0" />
                  {label}{asterisk && <span className="text-muted-foreground text-xs align-super -ml-1">*</span>}
                </li>
              ))}
            </ul>
          </div>

          <hr className="border-border/50" />

          <p className="py-8 text-base sm:text-lg font-medium text-foreground">
            everything included — no feature limits, no hidden tiers.
          </p>

          <hr className="border-border/50" />

          <div className="py-8">
            <Button
              asChild
              size="lg"
              className="w-full sm:w-auto mx-auto bg-accent-cyan hover:bg-accent-cyan-hover text-background font-semibold px-10 h-12 text-base"
            >
              <Link href="/register">get started for free</Link>
            </Button>
          </div>
        </div>

        <p className="mt-10 section-subheadline">
          need volume pricing or an enterprise agreement?{' '}
          <a href="mailto:support@owlette.app" className="text-foreground hover:underline underline-offset-4">
            get in touch
          </a>
        </p>
        <p className="mt-10 text-sm text-muted-foreground/60">
          * cortex requires your own API key (OpenAI, Anthropic, or compatible)
        </p>
      </div>
    </section>
  );
}
