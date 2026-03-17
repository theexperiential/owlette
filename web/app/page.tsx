import {
  LandingHeader,
  HeroSection,
  UseCaseSection,
  FeatureGrid,
  CTASection,
  LandingFooter,
} from '@/components/landing';

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <LandingHeader />
      <main>
        <HeroSection />
        <UseCaseSection />
        <FeatureGrid />
        <CTASection />
      </main>
      <LandingFooter />
    </div>
  );
}
