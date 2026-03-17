import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export function CTASection() {
  return (
    <section className="py-16 sm:py-24 md:py-32 px-4 sm:px-6 relative overflow-hidden">
      {/* Blueprint grid background */}
      <div className="absolute inset-0 blueprint-grid-accent opacity-10" />

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-accent-cyan/5 via-transparent to-transparent" />

      <div className="relative z-10 max-w-3xl mx-auto text-center">
        {/* Beta Badge */}
        <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 mb-4 sm:mb-6">
          <div className="w-1.5 sm:w-2 h-1.5 sm:h-2 rounded-full bg-accent-cyan animate-pulse" />
          <span className="text-accent-cyan text-xs sm:text-sm font-medium">Public Beta</span>
        </div>

        {/* Headline */}
        <h2 className="section-headline text-foreground mb-3 sm:mb-4">
          Ready to take control?
        </h2>
        <p className="section-subheadline max-w-xl mx-auto mb-8 sm:mb-10 px-4 sm:px-0">
          Owlette is currently in public beta and free to use.
          We&apos;re building turnkey infrastructure for AV professionals—pricing will be announced when we launch.
        </p>

        {/* CTA Button */}
        <Button
          asChild
          size="lg"
          className="bg-accent-cyan hover:bg-accent-cyan-hover text-background font-semibold px-8 sm:px-10 h-12 sm:h-14 text-base sm:text-lg group"
        >
          <Link href="/register" className="flex items-center gap-2">
            Join the Beta
            <ArrowRight className="w-4 sm:w-5 h-4 sm:h-5 group-hover:translate-x-1 transition-transform" />
          </Link>
        </Button>

        {/* Trust signals */}
        <div className="flex flex-wrap justify-center gap-4 sm:gap-6 mt-8 sm:mt-12 text-xs sm:text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className="w-1 sm:w-1.5 h-1 sm:h-1.5 rounded-full bg-accent-cyan" />
            <span>Free during beta</span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className="w-1 sm:w-1.5 h-1 sm:h-1.5 rounded-full bg-accent-cyan" />
            <span>No credit card</span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className="w-1 sm:w-1.5 h-1 sm:h-1.5 rounded-full bg-accent-cyan" />
            <span>Open source</span>
          </div>
        </div>
      </div>
    </section>
  );
}
