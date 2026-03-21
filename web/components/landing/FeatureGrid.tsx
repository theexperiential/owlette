export function FeatureGrid() {
  const industries = [
    'theme parks',
    'digital signage',
    'museums',
    'live events',
    'galleries',
    'media servers',
  ];

  return (
    <section className="py-16 sm:py-24 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-sm sm:text-base text-muted-foreground mb-6">
          built for
        </p>
        <div className="flex flex-wrap justify-center gap-x-3 sm:gap-x-4 gap-y-2">
          {industries.map((industry, i) => (
            <span key={industry} className="flex items-center gap-3 sm:gap-4">
              <span className="text-lg sm:text-2xl font-heading font-semibold text-foreground/80 hover:text-accent-warm transition-colors cursor-default">
                {industry}
              </span>
              {i < industries.length - 1 && (
                <span className="text-accent-warm/40 text-lg select-none">/</span>
              )}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
