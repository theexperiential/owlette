'use client';

import { useState } from 'react';
import { Activity, Brain, ChevronDown, Power, Rocket, type LucideIcon } from 'lucide-react';
import Image from 'next/image';

const capabilities: { label: string; detail: string; expanded: string; preview: string; icon: LucideIcon }[] = [
  {
    label: 'monitor',
    detail: 'real-time metrics and email/webhook notifications',
    expanded: 'live cpu, memory, gpu, and disk usage for every machine. inline sparkline charts track trends over time. know instantly when something drifts.',
    preview: '/monitor.png',
    icon: Activity,
  },
  {
    label: 'control',
    detail: 'start, stop, or restart any process — with a full API',
    expanded: 'full remote process control across your entire fleet. configure startup sequences, manage dependencies, and auto-restart crashed processes before anyone notices.',
    preview: '/control.png',
    icon: Power,
  },
  {
    label: 'deploy',
    detail: 'push software updates to all machines at once',
    expanded: 'deploy software, configurations, and content to any machine, anywhere. fleet-wide rollouts or targeted single-machine updates — your call.',
    preview: '/preview-deploy.png',
    icon: Rocket,
  },
  {
    label: 'converse',
    detail: 'talk to your machines like a human with cortex',
    expanded: 'cortex lets you talk to your machines in natural language. ask questions, run diagnostics, and execute commands across your fleet through a conversational interface.',
    preview: '/preview-converse.png',
    icon: Brain,
  },
];

export function UseCaseSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const toggle = (i: number) => {
    setOpenIndex(openIndex === i ? null : i);
  };

  const activePreview = openIndex !== null ? capabilities[openIndex].preview : undefined;

  return (
    <section className="pt-24 sm:pt-32 pb-20 sm:pb-32 px-4 sm:px-6 relative">
      <div className="max-w-5xl mx-auto relative">

        {/* Mobile: single-column accordion — each card owns its expanded content */}
        <div className="flex flex-col gap-2 lg:hidden">
          {capabilities.map((cap, i) => (
            <div key={cap.label}>
              <button
                onClick={() => toggle(i)}
                className={`w-full text-center group cursor-pointer rounded-lg p-4 transition-all duration-300 border ${openIndex === i ? 'bg-card/60 border-border' : 'border-transparent hover:bg-card/50'}`}
              >
                <cap.icon className={`w-8 h-8 mx-auto mb-3 transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-muted-foreground group-hover:text-accent-cyan'}`} />
                <div className="flex items-center justify-center gap-1.5 mb-2">
                  <h3 className={`text-xl font-bold font-heading transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-foreground group-hover:text-accent-cyan'}`}>
                    {cap.label}
                  </h3>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${openIndex === i ? 'rotate-180' : ''}`}
                  />
                </div>
                <p className="text-base text-muted-foreground">
                  {cap.detail}
                </p>
              </button>

              {/* Expanded content inline below the card */}
              <div className={`overflow-hidden transition-all duration-500 ease-out ${openIndex === i ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'}`}>
                <p className="text-sm text-muted-foreground/80 leading-relaxed text-center px-6 pb-4 animate-in fade-in duration-300">
                  {cap.expanded}
                </p>
                <div className="px-2 pb-4">
                  <div className="relative rounded-xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/5"
                    style={{
                      maskImage: 'linear-gradient(to bottom, black 80%, transparent)',
                      WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent)',
                    }}
                  >
                    <Image
                      src={cap.preview}
                      alt={`${cap.label} preview`}
                      width={2300}
                      height={1050}
                      className="w-full h-auto"
                      priority
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop: 4-column grid with shared preview area below */}
        <div className="hidden lg:block">
          <div className="grid grid-cols-4 gap-6 items-start">
            {capabilities.map((cap, i) => (
              <button
                key={cap.label}
                onClick={() => toggle(i)}
                className={`text-center group cursor-pointer rounded-lg p-4 transition-all duration-300 border ${openIndex === i ? 'bg-card/60 border-border' : 'border-transparent hover:bg-card/50'}`}
              >
                <cap.icon className={`w-8 h-8 mx-auto mb-3 transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-muted-foreground group-hover:text-accent-cyan'}`} />
                <div className="flex items-center justify-center gap-1.5 mb-2">
                  <h3 className={`text-2xl font-bold font-heading transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-foreground group-hover:text-accent-cyan'}`}>
                    {cap.label}
                  </h3>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${openIndex === i ? 'rotate-180' : ''}`}
                  />
                </div>
                <p className="text-base text-muted-foreground">
                  {cap.detail}
                </p>
              </button>
            ))}
          </div>

          {/* Expanded text — mirrored grid so text appears below its card */}
          {openIndex !== null && (
            <div className="grid grid-cols-4 gap-6 mt-2">
              {capabilities.map((cap, i) => (
                <div key={cap.label} className={i === openIndex ? 'animate-in fade-in duration-300' : ''}>
                  {i === openIndex && (
                    <p className="text-sm text-muted-foreground/80 leading-relaxed text-center px-2">
                      {cap.expanded}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Preview image — below the grid so cards never shift */}
          <div
            className={`overflow-hidden transition-all duration-500 ease-out ${activePreview ? 'max-h-[800px] opacity-100 mt-8' : 'max-h-0 opacity-0 mt-0'}`}
          >
            <div className="relative rounded-xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/5"
              style={{
                maskImage: 'linear-gradient(to bottom, black 80%, transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                maskComposite: 'intersect',
                WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                WebkitMaskComposite: 'source-in',
              }}
            >
              <div className="relative">
                {capabilities.map((cap) => (
                  <div
                    key={cap.preview}
                    className="transition-all duration-500 ease-out"
                    style={{
                      opacity: activePreview === cap.preview ? 1 : 0,
                      position: activePreview === cap.preview ? 'relative' : 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: activePreview === cap.preview ? 'translateY(0)' : 'translateY(12px)',
                    }}
                  >
                    <Image
                      src={cap.preview}
                      alt={`${cap.label} preview`}
                      width={2300}
                      height={1050}
                      className="w-full h-auto"
                      priority
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}
