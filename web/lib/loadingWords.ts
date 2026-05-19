export const LOADING_WORDS = [
  'cooking',
  'rendering',
  'buffering',
  'ingesting',
  'cueing',
  'patching',
  'compositing',
  'provisioning',
  'deploying',
  'booting',
] as const;

export type LoadingWord = (typeof LOADING_WORDS)[number];

export function getLoadingWord(): LoadingWord {
  return LOADING_WORDS[Math.floor(Math.random() * LOADING_WORDS.length)];
}
