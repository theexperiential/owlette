/**
 * Dashboard Constants
 *
 * Multilingual welcome messages and tech jokes for the dashboard page.
 * Extracted from dashboard/page.tsx for better maintainability.
 */

export interface WelcomeMessage {
  text: string;
  language: string;
  translation: string;
}

/**
 * Multilingual welcome messages with language info
 * Weighted towards English and Spanish, with representation from 30+ languages
 */
export const WELCOME_MESSAGES: WelcomeMessage[] = [
  // English (heavy)
  { text: "Welcome back", language: "English", translation: "Welcome back" },
  { text: "Greetings", language: "English", translation: "Greetings" },
  { text: "Hey there", language: "English (casual)", translation: "Hey there" },
  { text: "Good to see you", language: "English", translation: "Good to see you" },
  { text: "Hello again", language: "English", translation: "Hello again" },
  { text: "Welcome", language: "English", translation: "Welcome" },
  { text: "Howdy", language: "English (Southern US)", translation: "Howdy" },
  { text: "What's up", language: "English (casual)", translation: "What's up" },
  { text: "G'day", language: "English (Australian)", translation: "G'day / Good day" },
  { text: "Cheers", language: "English (British)", translation: "Cheers / Hello" },

  // Spanish (heavy)
  { text: "Bienvenido", language: "Spanish", translation: "Welcome" },
  { text: "Hola de nuevo", language: "Spanish", translation: "Hello again" },
  { text: "Qué tal", language: "Spanish (casual)", translation: "What's up / How's it going" },
  { text: "Saludos", language: "Spanish", translation: "Greetings" },
  { text: "Buenas", language: "Spanish (casual)", translation: "Hey / Hi there" },
  { text: "Hola", language: "Spanish", translation: "Hello" },
  { text: "Bienvenido de vuelta", language: "Spanish", translation: "Welcome back" },
  { text: "Qué onda", language: "Spanish (Mexican)", translation: "What's up" },
  { text: "¿Cómo estás?", language: "Spanish", translation: "How are you?" },
  { text: "Encantado de verte", language: "Spanish", translation: "Pleased to see you" },

  // French
  { text: "Bienvenue", language: "French", translation: "Welcome" },
  { text: "Salut", language: "French (casual)", translation: "Hi" },
  { text: "Bon retour", language: "French", translation: "Good return / Welcome back" },

  // German
  { text: "Willkommen zurück", language: "German", translation: "Welcome back" },
  { text: "Hallo", language: "German", translation: "Hello" },
  { text: "Grüß dich", language: "German (casual)", translation: "Greetings to you" },

  // Italian
  { text: "Benvenuto", language: "Italian", translation: "Welcome" },
  { text: "Ciao", language: "Italian", translation: "Hi / Bye" },

  // Portuguese
  { text: "Bem-vindo de volta", language: "Portuguese", translation: "Welcome back" },
  { text: "Olá", language: "Portuguese", translation: "Hello" },

  // Dutch
  { text: "Welkom terug", language: "Dutch", translation: "Welcome back" },

  // Russian
  { text: "Добро пожаловать", language: "Russian", translation: "Welcome" },
  { text: "Привет", language: "Russian", translation: "Hi" },

  // Asian languages
  { text: "欢迎回来", language: "Chinese (Simplified)", translation: "Welcome back" },
  { text: "ようこそ", language: "Japanese", translation: "Welcome" },
  { text: "환영합니다", language: "Korean", translation: "Welcome" },
  { text: "स्वागत है", language: "Hindi", translation: "Welcome" },
  { text: "ยินดีต้อนรับกลับมา", language: "Thai", translation: "Welcome back" },
  { text: "Chào mừng trở lại", language: "Vietnamese", translation: "Welcome back" },

  // Middle Eastern
  { text: "مرحبا بعودتك", language: "Arabic", translation: "Welcome back" },
  { text: "ברוך השב", language: "Hebrew", translation: "Blessed is the return" },
  { text: "Hoş geldin", language: "Turkish", translation: "Welcome" },

  // Scandinavian
  { text: "Välkommen tillbaka", language: "Swedish", translation: "Welcome back" },
  { text: "Velkommen tilbage", language: "Danish", translation: "Welcome back" },
  { text: "Velkommen tilbake", language: "Norwegian", translation: "Welcome back" },
  { text: "Tervetuloa takaisin", language: "Finnish", translation: "Welcome back" },

  // Other European
  { text: "Witaj ponownie", language: "Polish", translation: "Welcome again" },
  { text: "Vítejte zpět", language: "Czech", translation: "Welcome back" },
  { text: "Καλώς ήρθες πάλι", language: "Greek", translation: "Welcome back" },
  { text: "Bine ai revenit", language: "Romanian", translation: "Good you returned" },

  // Southeast Asian
  { text: "Selamat datang kembali", language: "Indonesian", translation: "Safe arrival back" },
  { text: "Maligayang pagbabalik", language: "Filipino", translation: "Happy return" },

  // Celtic
  { text: "Fàilte air ais", language: "Scottish Gaelic", translation: "Welcome back" },
  { text: "Croeso yn ôl", language: "Welsh", translation: "Welcome back" },
  { text: "Fáilte ar ais", language: "Irish", translation: "Welcome back" },
];

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

/**
 * Random cheesy tech jokes for dashboard tagline
 * Process management and GPU-themed humor
 */
export const TECH_JOKES: string[] = [
  "Your pixels are in good hands",
  "Keeping your GPUs well-fed and happy",
  "Because Ctrl+Alt+Delete is so 2000s",
  "Herding your processes since 2025",
  "Making sure your renders don't surrender",
  "Your CPU's personal trainer",
  "We put the 'auto' in autolaunch",
  "Babysitting processes so you don't have to",
  "Keeping the frames flowing",
  "Process management: Now streaming",
  "Your digital janitor service",
  "Making computers computier since 2025",
  "Because someone has to babysit your GPUs",
  "Turning crashes into... well, less crashes",
  "Your processes' favorite nanny",
  "We'll handle the restarts, you handle the art",
  "Keeping your render farm from going on strike",
  "Process wrangling at its finest",
  "Making sure your video doesn't get stagefright",
  "Your machines' remote control, literally",
  "Teaching old GPUs new tricks",
  "We don't judge your 47 Chrome tabs",
  "Remotely judging your cable management",
  "Making Windows behave since 2025",
  "Your processes called, they want a manager",
  "Turning blue screens into green lights",
  "The cloud's favorite floor manager",
  "Because 'Have you tried turning it off and on again?' gets old",
  "Your GPU's therapist",
  "Making sure your RAM doesn't feel lonely",
  "Process management with extra cheese",
  "We put the 'service' in Windows Service",
  "Keeping your video walls from having a meltdown",
  "Because manual restarts are for peasants",
  "Your installation's guardian angel",
  "Making TouchDesigner touch easier",
  "Render farm to table, fresh processes daily",
  "We speak fluent GPU",
  "Your digital signage's best friend",
  "Because someone needs to watch the watchers",
  "Turning 'It works on my machine' into reality",
  "Process therapy, cloud edition",
  "Making Resolume resolve to stay running",
  "Your kiosk's remote babysitter",
  "Because uptime is updog",
  "GPU whisperer extraordinaire",
  "Making your media servers less dramatic",
  "We've seen things... running things",
  "Your process's life coach",
  "Because closing Task Manager won't fix this",
  "Keeping your renders rendering since 2025",
  "The owl watches over your processes",
  "Making Windows services less mysterious",
  "Your exhibition's technical director",
  "Process management: It's not rocket science, it's harder"
];

/**
 * Helper function to get a random welcome message
 */
export const getRandomWelcomeMessage = (): WelcomeMessage => {
  return WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)];
};

/**
 * Helper function to get a random tech joke
 */
export const getRandomTechJoke = (): string => {
  return TECH_JOKES[Math.floor(Math.random() * TECH_JOKES.length)];
};
