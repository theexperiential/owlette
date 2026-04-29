'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, KeyRound, RefreshCw, Webhook } from 'lucide-react';

type TabId = 'curl' | 'cli' | 'typescript';

const TABS: { id: TabId; label: string }[] = [
  { id: 'curl', label: 'curl' },
  { id: 'cli', label: 'cli' },
  { id: 'typescript', label: 'typescript' },
];

const SAMPLES: Record<TabId, string> = {
  curl: `curl -X POST https://owlette.app/api/sites/$SITE/machines/$MACHINE/processes/$PROC/restart \\
  -H "Authorization: Bearer $OWLETTE_TOKEN" \\
  -H "Idempotency-Key: $(uuidgen)"`,
  cli: `owlette process restart $PROC --site $SITE --machine $MACHINE`,
  typescript: `import { Owlette } from '@owlette/sdk';

const owlette = new Owlette({ token: process.env.OWLETTE_TOKEN! });
await owlette.processes(siteId, machineId).restart(processId);`,
};

const PROOF_CHIPS: { icon: typeof KeyRound; label: string; body: string }[] = [
  {
    icon: KeyRound,
    label: 'scoped keys',
    body: 'keys are scoped per-site and per-action. a webhook delivery key cannot restart a machine.',
  },
  {
    icon: RefreshCw,
    label: 'idempotency-key required on writes',
    body: 'every mutating endpoint enforces idempotency. retry without doubling up.',
  },
  {
    icon: Webhook,
    label: 'webhooks with HMAC signatures',
    body: 'subscribe to process / deploy / display events. signed payloads, verifiable in any language.',
  },
];

export function DeveloperSection() {
  const [activeTab, setActiveTab] = useState<TabId>('curl');

  return (
    <section id="developers" className="py-16 sm:py-24 px-4 sm:px-6 relative">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12 sm:mb-16">
          <h2 className="section-headline text-foreground mb-4 leading-tight">
            script your fleet. or don&apos;t.
          </h2>
          <p className="section-subheadline text-balance max-w-3xl mx-auto">
            every dashboard action is a documented REST endpoint. scoped keys,
            idempotency, webhooks, OpenAPI. install the CLI on a runner, import
            the SDK into your backend, or just curl it.
          </p>
        </div>

        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
          {/* Code block — 60% on desktop, full on mobile */}
          <div className="lg:w-3/5">
            <div className="rounded-xl border border-border bg-card/60 shadow-2xl shadow-black/30 ring-1 ring-white/5 overflow-hidden">
              <div role="tablist" className="flex border-b border-border bg-card/40">
                {TABS.map((tab) => {
                  const isActive = tab.id === activeTab;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveTab(tab.id)}
                      className={`px-4 py-2.5 text-sm font-mono transition-colors cursor-pointer border-b-2 -mb-px ${
                        isActive
                          ? 'text-accent-cyan border-accent-cyan'
                          : 'text-muted-foreground border-transparent hover:text-foreground'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              <pre className="p-4 sm:p-5 text-xs sm:text-sm font-mono text-foreground/90 leading-relaxed overflow-x-auto">
                <code>{SAMPLES[activeTab]}</code>
              </pre>
            </div>
          </div>

          {/* Proof chips — 40% on desktop, stacked below on mobile */}
          <div className="lg:w-2/5 flex flex-col gap-4">
            {PROOF_CHIPS.map((chip) => (
              <div
                key={chip.label}
                className="rounded-xl border border-border bg-card/60 p-4 sm:p-5 shadow-2xl shadow-black/30 ring-1 ring-white/5"
              >
                <div className="flex items-center gap-2 mb-2">
                  <chip.icon className="w-4 h-4 text-accent-cyan flex-shrink-0" />
                  <h3 className="text-sm font-semibold text-foreground">
                    {chip.label}
                  </h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {chip.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-10 mt-12 sm:mt-16">
          <Link
            href="/docs/api"
            className="inline-flex items-center gap-1.5 text-base text-accent-cyan hover:text-accent-cyan-hover transition-colors group"
          >
            read the API reference
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </Link>
          <Link
            href="https://github.com/theexperiential/owlette/tree/main/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-base text-muted-foreground hover:text-foreground transition-colors group"
          >
            install the CLI
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </div>
    </section>
  );
}
