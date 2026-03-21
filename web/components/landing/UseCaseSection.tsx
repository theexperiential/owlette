'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import Image from 'next/image';

const capabilities = [
  {
    label: 'monitor',
    detail: 'real-time metrics across your fleet',
    expanded: 'live cpu, memory, gpu, and disk usage for every machine. inline sparkline charts track trends over time. know instantly when something drifts.',
    preview: '/dashboard-preview.png',
  },
  {
    label: 'control',
    detail: 'start, stop, restart — from anywhere',
    expanded: 'full remote process control across your entire fleet. configure startup sequences, manage dependencies, and auto-restart crashed processes before anyone notices.',
  },
  {
    label: 'deploy',
    detail: 'push updates to every machine at once',
    expanded: 'deploy software, configurations, and content to any machine, anywhere. fleet-wide rollouts or targeted single-machine updates — your call.',
    preview: '/deploy-preview.png',
  },
  {
    label: 'converse',
    detail: 'conversational fleet management',
    expanded: 'cortex lets you talk to your machines in natural language. ask questions, run diagnostics, and execute commands across your fleet through a conversational interface.',
  },
];

export function UseCaseSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const toggle = (i: number) => {
    setOpenIndex(openIndex === i ? null : i);
  };

  const activePreview = openIndex !== null ? capabilities[openIndex].preview : undefined;

  return (
    <section className="pt-40 sm:pt-52 pb-20 sm:pb-32 px-4 sm:px-6 relative">
      {/* Warm gradient accent */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-accent-warm/[0.02] to-transparent pointer-events-none" />

      <div className="max-w-5xl mx-auto relative">
        {/* Preview image — positioned above the grid without pushing it down */}
        <div
          className={`absolute bottom-full left-0 right-0 mb-6 transition-all duration-500 ease-out pointer-events-none ${activePreview ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}
        >
          {activePreview && (
            <div className="relative rounded-xl overflow-hidden shadow-2xl shadow-accent-cyan/5"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent, black 25px, black calc(100% - 25px), transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                maskComposite: 'intersect',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 25px, black calc(100% - 25px), transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                WebkitMaskComposite: 'source-in',
              }}
            >
              <Image
                src={activePreview}
                alt="Owlette dashboard preview"
                width={1400}
                height={800}
                className="w-full h-auto"
                priority
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {capabilities.map((cap, i) => (
            <button
              key={cap.label}
              onClick={() => toggle(i)}
              className="text-center group cursor-pointer rounded-lg p-4 transition-all duration-300 hover:bg-card/50"
            >
              <div className="flex items-center justify-center gap-1.5 mb-2">
                <h3 className={`text-xl sm:text-2xl font-bold font-heading transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-foreground group-hover:text-accent-cyan'}`}>
                  {cap.label}
                </h3>
                <ChevronDown
                  className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${openIndex === i ? 'rotate-180' : ''}`}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {cap.detail}
              </p>

              {/* Expanded content */}
              <div
                className={`overflow-hidden transition-all duration-300 ${openIndex === i ? 'max-h-48 opacity-100 mt-3' : 'max-h-0 opacity-0'}`}
              >
                <p className="text-xs text-muted-foreground/80 leading-relaxed border-t border-border/30 pt-3">
                  {cap.expanded}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
