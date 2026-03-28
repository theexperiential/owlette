import {
  LandingHeader,
  HeroSection,
  ValuePropSection,
  UseCaseSection,
  FeatureGrid,
  CTASection,
  LandingFooter,
} from '@/components/landing';

export default function LandingPage() {
  return (
    <div className="min-h-screen relative">
      {/* Page-wide dot grid background */}
      <div className="fixed inset-0 dot-grid opacity-30 pointer-events-none" />
      <LandingHeader />
      <main>
        <HeroSection />
        <ValuePropSection />
        <UseCaseSection />
        <FeatureGrid />
        <CTASection />
      </main>
      <LandingFooter />
    </div>
  );
}
