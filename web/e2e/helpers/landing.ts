import { HERO_HEADLINES } from '@/lib/heroHeadlines';

/**
 * The landing hero picks its headline per request from HERO_HEADLINES, so
 * specs match the union of the curated list instead of pinning one phrase.
 *
 * Built from the app's own list rather than a hand-copied one: adding a phrase
 * in lib/heroHeadlines.ts is then covered here automatically, and removing one
 * can't leave a spec asserting copy the site no longer ships.
 */
export const HERO_HEADLINE = new RegExp(
  HERO_HEADLINES.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

/** The subhead is fixed — it's what grounds whichever headline was rolled. */
export const HERO_SUBHEADLINE = /owlette keeps your installations running 24\/7/i;
