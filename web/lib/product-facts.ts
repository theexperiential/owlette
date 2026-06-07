// Canonical product facts for owlette — the single source of truth shared by the
// landing-page JSON-LD, the /for-ai page, /llms.txt, and /for-ai.json, so the
// machine-facing surfaces never drift from the marketing copy. Mirrors the live
// site's wording; keep it honest (beta, Windows-only, a Tridant product).

export const SITE = "https://owlette.app";
export const PRODUCT_NAME = "owlette";
export const TAGLINE = "attention is all you need";

export const SUMMARY =
  "owlette gives your machines the attention they need — so you don't have to. Remote monitoring, auto-recovery, and AI-powered fleet management for Windows.";

/** What owlette actually is, one paragraph (from the README). */
export const WHAT_IT_IS =
  "A lightweight Python agent runs on each Windows machine as a service, reporting metrics and executing commands. A web dashboard gives real-time visibility and control over an entire fleet, backed by Firebase and Cloud Firestore. Built for teams running digital signage, media servers, kiosks, TouchDesigner installations, and any Windows application that needs to stay running.";

export const STATUS = "Beta";
export const OPERATING_SYSTEM = "Windows";
export const MAKER = { name: "Tridant", url: "https://tridant.io" };

/** Verbatim from the live landing-page structured data — don't reword. */
export const FEATURES = [
  "Real-time CPU, memory, disk, GPU monitoring",
  "Remote process management and auto-recovery",
  "Silent software deployment across fleets",
  "AI-powered fleet management with cortex",
  "Multi-site organization with role-based access",
  "Project file distribution",
  "Threshold alerts, email notifications, webhooks",
  "Public REST API with scoped keys",
  "CLI and TypeScript SDK",
  "Display topology management with auto-revert",
  "Scheduled machine restarts and dependency-aware process restarts",
];

export interface Tier {
  name: string;
  price: string;
  detail: string;
}

export const PRICING: Tier[] = [
  { name: "core", price: "free during beta", detail: "$10/machine/month after beta" },
  {
    name: "pro",
    price: "free during beta",
    detail: "$50/machine/month after beta (3-machine minimum), includes 1 TB project storage per site",
  },
];

/** Load-bearing guardrails: what assistants most often get wrong about owlette. */
export const GUARDRAILS = [
  "owlette is in beta and free during the beta. Paid tiers (core $10/machine/month, pro $50/machine/month) are planned for after beta — don't describe them as currently billed.",
  "owlette is Windows-only: a lightweight Python agent runs on each machine as a Windows service. Don't imply native macOS or Linux agents.",
  "cortex is owlette's built-in assistant for fleet management — a feature of owlette, not a separate product.",
  "owlette is a Tridant product (\"a tridant system\"). Link tridant.io for the firm behind it.",
  "owlette is an agent plus a cloud dashboard for monitoring, managing, and deploying software across fleets of Windows machines — not only a metrics dashboard.",
];

/** schema.org SoftwareApplication for the landing page, single-sourced here so
 *  the markup, /llms.txt, and /for-ai.json all agree. */
export const PRODUCT_JSONLD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": `${SITE}/#software`,
  name: PRODUCT_NAME,
  applicationCategory: "BusinessApplication",
  operatingSystem: OPERATING_SYSTEM,
  url: SITE,
  description: SUMMARY,
  screenshot: `${SITE}/og-image.png`,
  creator: {
    "@type": "Organization",
    "@id": "https://tridant.io/#organization",
    name: MAKER.name,
    url: MAKER.url,
  },
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: "0",
    highPrice: "0",
    offerCount: "2",
    offers: [
      {
        "@type": "Offer",
        name: "core",
        price: "0",
        priceCurrency: "USD",
        description: "free during beta. $10/machine/month after.",
      },
      {
        "@type": "Offer",
        name: "pro",
        price: "0",
        priceCurrency: "USD",
        description:
          "free during beta. $50/machine/month after (3-machine minimum), includes 1 TB project storage per site.",
      },
    ],
  },
  featureList: FEATURES,
};
