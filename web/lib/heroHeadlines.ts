// The landing hero headline rotates on every page load. This list is the
// single source of truth for both the rendered <h1> and the e2e specs that
// assert on it — a spec carrying its own copy of the phrases would silently
// stop covering any phrase added here.
//
// House style for additions: lowercase, and short enough to hold at most two
// lines at the hero's 72px ceiling (roughly 28 characters per line). Each one
// has to read as a promise directly above the fixed subhead, "owlette keeps
// your installations running 24/7" — that sentence is what grounds the more
// elliptical phrases, so it stays put while these rotate.

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
 * Server-only by contract: the hero is a client component, so choosing inside
 * it would roll once during the server render and again during hydration,
 * giving React two different strings for the same node. Call this from the
 * server component that renders the hero and pass the result down as a prop.
 */
export function pickHeroHeadline(): HeroHeadline {
  return HERO_HEADLINES[Math.floor(Math.random() * HERO_HEADLINES.length)];
}
