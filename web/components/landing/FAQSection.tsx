'use client';

import { useState } from 'react';
import React from 'react';
import { Plus, Minus } from 'lucide-react';

const faqs: { q: string; a: React.ReactNode }[] = [
  {
    q: "is it actually free?",
    a: "during beta, yes. no credit card, no trial clock, no free-tier sleight of hand. after beta it's $10/machine/month — no seats, no tiers, no hidden fees. just machines.",
  },
  {
    q: "does it work on mac or linux?",
    a: "no. owlette is windows-only. your mac is fine — it doesn't need monitoring. it'll let you know when something's wrong. loudly. in the middle of a show.",
  },
  {
    q: "what happens if my machine loses internet?",
    a: "the agent keeps running. it monitors and auto-recovers processes whether or not it can reach the cloud. when the connection returns, it syncs everything it missed. your machines don't need the internet to run. they've been alone before. they know how to survive.",
  },
  {
    q: "do i need to open firewall ports or set up a vpn?",
    a: "no inbound ports, no vpn. agents connect outbound over https (port 443) to google's firebase infrastructure. if your network allows general internet access, it just works. locked-down environments may need to whitelist *.googleapis.com and *.firebaseio.com.",
  },
  {
    q: "what's cortex?",
    a: "cortex is owlette's ai fleet assistant — ask it the questions you ask yourself every day: \"which nvidia driver are we running?\", \"restart the media server on node 3\", \"what crashed at 3am?\" it translates natural language into real commands across your fleet. you bring your own api key (openai, anthropic, or any compatible provider).",
  },
  {
    q: "is my data secure?",
    a: "agents connect over tls, credentials are encrypted on-device using a machine-bound key, and oauth tokens are never logged or stored in plaintext. access is managed through firebase auth with optional passkey and two-factor authentication.",
  },
  {
    q: "can i self-host it?",
    a: "yes — owlette is FSL-1.1-Apache-2.0 (converts to apache 2.0 two years after each release). the full source is on github. fair warning: it requires firebase, a railway (or equivalent) deployment for the web app, and a willingness to blow past your usage limits at 3am debugging support tickets from your neighbor's camper because your furnace broke and it's -10 outside. we won't talk you out of it, but the hosted version exists for a reason.",
  },
];

export function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="pt-16 sm:pt-24 pb-32 sm:pb-48 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-10 sm:mb-14">
          <h2 className="section-headline text-foreground mb-4">
            questions, answered.
          </h2>
        </div>

        <div className={`border-t transition-colors duration-300 ${openIndex === 0 ? 'border-transparent' : 'border-border'}`}>
          {faqs.map((faq, i) => {
            const isOpen = openIndex === i;
            return (
              <React.Fragment key={i}>
              <div
                className={`group px-6 transition-all duration-300 ${
                  isOpen ? 'bg-card/60 rounded-2xl border border-border' : 'hover:bg-white/[0.04]'
                }`}
              >
                <button
                  onClick={() => setOpenIndex(isOpen ? null : i)}
                  className="w-full flex items-center justify-between gap-4 py-7 text-left cursor-pointer"
                  aria-expanded={isOpen}
                >
                  <span className={`text-base sm:text-lg font-medium transition-colors duration-300 ${isOpen ? 'text-accent-cyan' : 'text-foreground/80 group-hover:text-foreground'}`}>
                    {faq.q}
                  </span>
                  {isOpen
                    ? <Minus className="w-4 h-4 text-accent-cyan shrink-0" />
                    : <Plus className="w-4 h-4 text-muted-foreground shrink-0 group-hover:text-foreground transition-colors" />
                  }
                </button>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateRows: isOpen ? '1fr' : '0fr',
                    transition: 'grid-template-rows 0.3s ease',
                  }}
                >
                  <div className="overflow-hidden">
                    <p className="pb-8 text-base sm:text-lg text-muted-foreground leading-loose">
                      {faq.a}
                    </p>
                  </div>
                </div>
              </div>
              {i < faqs.length - 1 && (
                <div className={`border-b transition-colors duration-300 ${isOpen || openIndex === i + 1 ? 'border-transparent' : 'border-border'}`} />
              )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}
