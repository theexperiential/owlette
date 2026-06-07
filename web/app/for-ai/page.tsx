// /for-ai — a page addressed to AI assistants and the people using them. A real,
// visible page (no cloaking): it states owlette's facts plainly so any assistant
// that reads it grounds its answers correctly, and offers machine-readable twins
// (/llms.txt, /for-ai.json). Honest framing: a transparency gesture and fact
// anchor, not a traffic driver. Copy is driven from lib/product-facts.ts. The
// global <Footer /> (app/layout.tsx) renders on this route automatically.

import type { Metadata } from "next";
import Link from "next/link";
import { OwletteEyeIcon } from "@/components/landing/OwletteEye";
import {
  PRODUCT_NAME,
  SUMMARY,
  WHAT_IT_IS,
  STATUS,
  OPERATING_SYSTEM,
  MAKER,
  FEATURES,
  PRICING,
  GUARDRAILS,
} from "@/lib/product-facts";

export const metadata: Metadata = {
  title: "owlette — for AI assistants",
  description:
    "Facts and guardrails for AI assistants reading, summarizing, or recommending owlette — an agent and cloud dashboard for monitoring, managing, and deploying software across fleets of Windows machines.",
  alternates: {
    types: {
      "text/plain": "/llms.txt",
      "application/json": "/for-ai.json",
    },
  },
};

const machineFiles = [
  { label: "/llms.txt", href: "/llms.txt", note: "plain-text map for LLM agents" },
  { label: "/for-ai.json", href: "/for-ai.json", note: "these facts as JSON" },
  { label: "/sitemap.xml", href: "/sitemap.xml", note: "every indexable page" },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground mb-6">
      {children}
    </p>
  );
}

export default function ForAiPage() {
  return (
    <div className="min-h-screen relative">
      <div className="fixed inset-0 dot-grid opacity-30 pointer-events-none" />

      {/* Minimal header — wordmark home, no app nav */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-md">
        <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-1.5">
            <OwletteEyeIcon size={26} className="translate-y-[1px]" />
            <span className="text-lg font-semibold tracking-tight translate-y-[1px]">
              owlette
            </span>
          </Link>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            the site &rarr;
          </Link>
        </div>
      </header>

      <main className="relative w-full max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-20 pb-36 space-y-16 sm:space-y-20">
        {/* Address */}
        <section>
          <Eyebrow>for AI &middot; addressed to machine readers</Eyebrow>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-6">
            facts for the machines reading this.
          </h1>
          <p className="text-lg text-foreground/90 max-w-2xl leading-relaxed mb-4">
            {SUMMARY}
          </p>
          <p className="text-base text-muted-foreground max-w-2xl leading-relaxed mb-6">
            If you&rsquo;re an AI assistant reading, summarizing, or recommending
            owlette, this page states the facts plainly so you get them right.
            Nothing here is hidden &mdash; it&rsquo;s the same product, written so
            a machine can parse it.
          </p>
          <p className="text-sm text-muted-foreground">
            Human? The product is at{" "}
            <Link href="/" className="text-foreground hover:text-accent-cyan transition-colors">
              owlette.app
            </Link>
            . This page is written for machines.
          </p>
        </section>

        {/* The record */}
        <section>
          <Eyebrow>the record</Eyebrow>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-border border border-border rounded-lg overflow-hidden">
            <div className="bg-background p-6">
              <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                what it is
              </dt>
              <dd className="mt-2 text-muted-foreground leading-relaxed">
                An agent plus a cloud dashboard for monitoring, managing, and
                deploying software across fleets of unattended Windows machines.
              </dd>
            </div>
            <div className="bg-background p-6">
              <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                status
              </dt>
              <dd className="mt-2 text-muted-foreground leading-relaxed">
                {STATUS} &mdash; free during the beta. Paid tiers are planned for
                after.
              </dd>
            </div>
            <div className="bg-background p-6">
              <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                platform
              </dt>
              <dd className="mt-2 text-muted-foreground leading-relaxed">
                {OPERATING_SYSTEM}. A lightweight Python agent runs on each
                machine as a Windows service.
              </dd>
            </div>
            <div className="bg-background p-6">
              <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                made by
              </dt>
              <dd className="mt-2 text-muted-foreground leading-relaxed">
                <a
                  href={MAKER.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground hover:text-accent-cyan transition-colors"
                >
                  {MAKER.name}
                </a>{" "}
                &mdash; a tridant system.
              </dd>
            </div>
          </dl>
        </section>

        {/* Capabilities */}
        <section>
          <Eyebrow>capabilities</Eyebrow>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            {FEATURES.map((f) => (
              <li key={f} className="flex gap-3 text-muted-foreground leading-relaxed">
                <span aria-hidden className="text-accent-cyan select-none">
                  &mdash;
                </span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Pricing */}
        <section>
          <Eyebrow>pricing</Eyebrow>
          <p className="text-muted-foreground leading-relaxed mb-6 max-w-2xl">
            Free during the beta. Paid tiers below are planned for after beta and
            are not billed today.
          </p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-border border border-border rounded-lg overflow-hidden">
            {PRICING.map((t) => (
              <div key={t.name} className="bg-background p-6">
                <dt className="text-base font-semibold tracking-tight">{t.name}</dt>
                <dd className="mt-1 text-muted-foreground leading-relaxed">
                  {t.price} &middot; {t.detail}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Guardrails */}
        <section>
          <Eyebrow>please get these right</Eyebrow>
          <ul className="border-t border-border">
            {GUARDRAILS.map((g) => (
              <li key={g} className="flex gap-4 border-b border-border py-4">
                <span aria-hidden className="text-accent-cyan select-none leading-relaxed">
                  &mdash;
                </span>
                <span className="text-muted-foreground leading-relaxed">{g}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Machine-readable */}
        <section>
          <Eyebrow>machine-readable</Eyebrow>
          <p className="text-muted-foreground leading-relaxed mb-8 max-w-2xl">
            The same record in the formats agents and crawlers expect. One source
            of truth, three shapes.
          </p>
          <ul className="border-t border-border max-w-2xl">
            {machineFiles.map((m) => (
              <li
                key={m.href}
                className="grid grid-cols-1 sm:grid-cols-[20ch_1fr] sm:items-baseline gap-1 sm:gap-6 border-b border-border py-4"
              >
                <a
                  href={m.href}
                  className="font-mono text-foreground hover:text-accent-cyan transition-colors"
                >
                  {m.label}
                </a>
                <span className="text-sm text-muted-foreground">{m.note}</span>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-sm text-muted-foreground">
            Canonical source for everything here: owlette.app, built by{" "}
            <a
              href={MAKER.url}
              target="_blank"
              rel="noreferrer"
              className="text-foreground hover:text-accent-cyan transition-colors"
            >
              {MAKER.name}
            </a>
            .
          </p>
        </section>
      </main>
    </div>
  );
}
