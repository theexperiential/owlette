import dynamic from 'next/dynamic';
import { headers } from 'next/headers';
import {
  LandingHeader,
  HeroSection,
  ValuePropSection,
  PricingSection,
  LandingFooter,
} from '@/components/landing';
import { PRODUCT_JSONLD } from '@/lib/product-facts';

// Lazy-load below-fold sections to reduce initial JS bundle
// Note: ValuePropSection stays static because it contains the LCP image (dashboard.png)
const UseCaseSection = dynamic(() => import('@/components/landing/UseCaseSection').then(m => ({ default: m.UseCaseSection })));
const DisplaySection = dynamic<{ nonce?: string }>(() => import('@/components/landing/DisplaySection').then(m => ({ default: m.DisplaySection })));
const DeveloperSection = dynamic(() => import('@/components/landing/DeveloperSection').then(m => ({ default: m.DeveloperSection })));
const FeatureGrid = dynamic(() => import('@/components/landing/FeatureGrid').then(m => ({ default: m.FeatureGrid })));
const ProofStrip = dynamic(() => import('@/components/landing/ProofStrip').then(m => ({ default: m.ProofStrip })));
const FAQSection = dynamic(() => import('@/components/landing/FAQSection').then(m => ({ default: m.FAQSection })));

// Landing-page structured data — single-sourced from lib/product-facts.ts so the
// markup, /llms.txt, /for-ai.json, and the /for-ai page can't drift apart.
const jsonLd = PRODUCT_JSONLD;

export default async function LandingPage() {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <div className="min-h-screen relative">
      <script
        nonce={nonce}
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Page-wide dot grid background */}
      <div className="fixed inset-0 dot-grid opacity-30 pointer-events-none" />
      <LandingHeader />
      <main>
        <HeroSection />
        <ValuePropSection />
        <UseCaseSection />
        <DisplaySection nonce={nonce} />
        <DeveloperSection />
        <FeatureGrid />
        <PricingSection />
        <ProofStrip />
        <FAQSection />
      </main>
      <LandingFooter />
    </div>
  );
}
