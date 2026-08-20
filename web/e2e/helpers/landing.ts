import { HERO_HEADLINES } from '@/lib/heroHeadlines';

/**
 * The landing hero picks a headline per request, so specs match the union of
 * HERO_HEADLINES rather than one phrase. Built from the app's own list, not a
 * hand-copied one, so edits to lib/heroHeadlines.ts stay covered automatically.
 */
export const HERO_HEADLINE = new RegExp(
  HERO_HEADLINES.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

/** The subhead is fixed — it's what grounds whichever headline was rolled. */
// \s (not a literal space): the rendered copy binds "running 24/7" with a
// non-breaking space so "24/7" can never orphan onto its own line, and a
// literal space in a regex matches only U+0020.
export const HERO_SUBHEADLINE = /owlette keeps your installations running\s24\/7/i;
