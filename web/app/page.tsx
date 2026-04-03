import dynamic from 'next/dynamic';
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
const FeatureGrid = dynamic(() => import('@/components/landing/FeatureGrid').then(m => ({ default: m.FeatureGrid })));
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
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
  featureList: [
    'Real-time CPU, memory, disk, GPU monitoring',
    'Remote process management and auto-recovery',
    'Silent software deployment across fleets',
    'AI-powered fleet management with Cortex',
    'Multi-site organization with role-based access',
    'Project file distribution',
    'Threshold alerts, email notifications, webhooks',
  ],
};

export default function LandingPage() {
  return (
    <div className="min-h-screen relative">
      <script
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
        <FeatureGrid />
        <PricingSection />
        <FAQSection />
      </main>
      <LandingFooter />
    </div>
  );
}
