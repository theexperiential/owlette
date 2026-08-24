// The landing hero headline rotates per page load. This list is the single source of
// truth for the rendered <h1> AND the e2e specs — a spec with its own copy would silently
// stop covering phrases added here.
//
// House style: lowercase, short enough for at most two lines at the hero's 72px ceiling
// (~28 chars/line), and each must read as a promise above the fixed subhead "owlette
// keeps your installations running 24/7", which grounds the more elliptical phrases.

export const HERO_HEADLINES = [
  'never miss a beat',
  'always watching',
  'never blink',
  'eyes on everything',
  'no blind spots',
  "it doesn't sleep",
  'awake at 3am',
  'the night shift',
  'always the first to know',
] as const;

export type HeroHeadline = (typeof HERO_HEADLINES)[number];

/**
 * Pick a headline at random.
 *
 * Server-only by contract: the hero is a client component, so choosing inside it would
 * roll once on the server render and again on hydration, giving React two strings for the
 * same node. Call from the server component that renders the hero and pass it down.
 */
export function pickHeroHeadline(): HeroHeadline {
  return HERO_HEADLINES[Math.floor(Math.random() * HERO_HEADLINES.length)];
}
