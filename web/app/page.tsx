import dynamic from 'next/dynamic';
import { headers } from 'next/headers';
import {
  LandingHeader,
  HeroSection,
  ValuePropSection,
  PricingSection,
  LandingFooter,
} from '@/components/landing';

// Lazy-load below-fold sections to reduce initial JS bundle
// Note: ValuePropSection stays static because it contains the LCP image (dashboard.png)
const UseCaseSection = dynamic(() => import('@/components/landing/UseCaseSection').then(m => ({ default: m.UseCaseSection })));
const DisplaySection = dynamic<{ nonce?: string }>(() => import('@/components/landing/DisplaySection').then(m => ({ default: m.DisplaySection })));
const DeveloperSection = dynamic(() => import('@/components/landing/DeveloperSection').then(m => ({ default: m.DeveloperSection })));
const FeatureGrid = dynamic(() => import('@/components/landing/FeatureGrid').then(m => ({ default: m.FeatureGrid })));
const ProofStrip = dynamic(() => import('@/components/landing/ProofStrip').then(m => ({ default: m.ProofStrip })));
const FAQSection = dynamic(() => import('@/components/landing/FAQSection').then(m => ({ default: m.FAQSection })));

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'owlette',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Windows',
  url: 'https://owlette.app',
  description: 'owlette gives your machines the attention they need — so you don\'t have to. remote monitoring, auto-recovery, and AI-powered fleet management for Windows.',
  screenshot: 'https://owlette.app/og-image.png',
  offers: {
    '@type': 'AggregateOffer',
    priceCurrency: 'USD',
    lowPrice: '0',
    highPrice: '0',
    offerCount: '2',
    offers: [
      {
        '@type': 'Offer',
        name: 'core',
        price: '0',
        priceCurrency: 'USD',
        description: 'free during beta. $10/machine/month after.',
      },
      {
        '@type': 'Offer',
        name: 'pro',
        price: '0',
        priceCurrency: 'USD',
        description: 'free during beta. $50/machine/month after (3-machine minimum), includes 1 TB project storage per site.',
      },
    ],
  },
  featureList: [
    'Real-time CPU, memory, disk, GPU monitoring',
    'Remote process management and auto-recovery',
    'Silent software deployment across fleets',
    'AI-powered fleet management with cortex',
    'Multi-site organization with role-based access',
    'Project file distribution',
    'Threshold alerts, email notifications, webhooks',
    'Public REST API with scoped keys',
    'CLI and TypeScript SDK',
    'Display topology management with auto-revert',
    'Scheduled reboots and dependency-aware restarts',
  ],
};

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
