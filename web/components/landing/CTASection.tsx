import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export function CTASection() {
  return (
    <section className="py-20 sm:py-32 px-4 sm:px-6 relative overflow-hidden">
      {/* Subtle warm gradient */}
      <div className="absolute inset-0 bg-gradient-to-t from-accent-warm/[0.03] via-transparent to-transparent" />

      <div className="relative z-10 max-w-2xl mx-auto text-center">
        <p className="text-sm text-accent-warm font-medium mb-4 tracking-wider uppercase">
          free during beta
        </p>

        <h2 className="section-headline text-foreground mb-8">
          ready to take control?
        </h2>

        <Button
          asChild
          size="lg"
          className="bg-accent-cyan hover:bg-accent-cyan-hover text-background font-semibold px-10 h-14 text-lg group"
        >
          <Link href="/register" className="flex items-center gap-2">
            get started
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
