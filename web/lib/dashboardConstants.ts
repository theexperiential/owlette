/**
 * Dashboard Constants
 *
 * Multilingual "you" translations used to label the user's own chat messages.
 * Extracted from dashboard/page.tsx for better maintainability.
 */

export interface YouTranslation {
  text: string;
  language: string;
}

/**
 * "you" in many languages, used to label the user's own chat messages.
 * Each message picks a deterministic entry based on its id, so the same
 * message always shows the same translation across re-renders.
 */
export const YOU_TRANSLATIONS: YouTranslation[] = [
  { text: "you", language: "English" },
  { text: "tú", language: "Spanish" },
  { text: "usted", language: "Spanish (formal)" },
  { text: "tu", language: "French" },
  { text: "vous", language: "French (formal)" },
  { text: "du", language: "German" },
  { text: "Sie", language: "German (formal)" },
  { text: "tu", language: "Italian" },
  { text: "você", language: "Portuguese" },
  { text: "你", language: "Chinese (Simplified)" },
  { text: "您", language: "Chinese (formal)" },
  { text: "あなた", language: "Japanese" },
  { text: "君", language: "Japanese (casual)" },
  { text: "너", language: "Korean" },
  { text: "당신", language: "Korean (formal)" },
  { text: "आप", language: "Hindi (formal)" },
  { text: "तुम", language: "Hindi" },
  { text: "أنت", language: "Arabic" },
  { text: "ты", language: "Russian" },
  { text: "вы", language: "Russian (formal)" },
  { text: "jij", language: "Dutch" },
  { text: "du", language: "Swedish" },
  { text: "du", language: "Norwegian" },
  { text: "du", language: "Danish" },
  { text: "sinä", language: "Finnish" },
  { text: "ty", language: "Polish" },
  { text: "te", language: "Hungarian" },
  { text: "tu", language: "Romanian" },
  { text: "εσύ", language: "Greek" },
  { text: "sen", language: "Turkish" },
  { text: "bạn", language: "Vietnamese" },
  { text: "คุณ", language: "Thai" },
  { text: "kamu", language: "Indonesian" },
  { text: "ikaw", language: "Filipino" },
  { text: "אתה", language: "Hebrew" },
  { text: "wewe", language: "Swahili" },
  { text: "jy", language: "Afrikaans" },
  { text: "ти", language: "Ukrainian" },
  { text: "ti", language: "Croatian" },
  { text: "tu", language: "Catalan" },
  { text: "zu", language: "Basque" },
  { text: "ti", language: "Welsh" },
  { text: "tú", language: "Irish" },
  { text: "þú", language: "Icelandic" },
  { text: "vi", language: "Esperanto" },
];
