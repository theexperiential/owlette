import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Footer } from "@/components/Footer";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://owlette.app';

export const metadata: Metadata = {
  title: "owlette — attention is all you need",
  description: "owlette gives your machines the attention they need — so you don't have to. remote monitoring, auto-recovery, and AI-powered fleet management for Windows.",
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/owlette-icon.png',
  },
  openGraph: {
    title: "owlette — attention is all you need",
    description: "owlette gives your machines the attention they need — so you don't have to. remote monitoring, auto-recovery, and AI-powered fleet management for Windows.",
    url: siteUrl,
    siteName: "owlette",
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'owlette dashboard — fleet monitoring and control',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: "owlette — attention is all you need",
    description: "owlette gives your machines the attention they need — so you don't have to. remote monitoring, auto-recovery, and AI-powered fleet management for Windows.",
    images: ['/og-image.png'],
  },
  metadataBase: new URL(siteUrl),
  manifest: '/manifest.json',
  other: {
    'theme-color': '#0a0f1a',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Validate Firebase environment variables
  // In development: logs warnings
  // In production: throws error if misconfigured
  // TEMPORARILY DISABLED for initial Railway deployment
  // validateEnvironmentOrThrow();

  return (
    <html lang="en" className="dark scroll-smooth">
      <body
        className={`${geist.variable} ${geistMono.variable} font-sans antialiased text-foreground`}
      >
        <span dangerouslySetInnerHTML={{ __html: `<!--


    :::::..                           ...::::::--:::::::::::......
    :::::....                              :.:::::-:::::::::.  ..:
    ::---------:.                           .:*-.:-:::::::::.   .:
    :::--------.                         :-=+??-.*+-::::::::.   .:
    -::::-----               :-.       ...-**=:.:=**=:::::::.    .
    -:::::--:               -*?*       :--+%=  =-=+*+-::::::.    .
    -::.::-.                 .:.      .:..=?+  :-=+**=::::-:.
    -:..::.                        ...    .*?*=-===***=::--:.
    -::.:.                     ..::..      *%SS%%*=+**=-:--:.
    -:::.                       ....      .?%SSSS%?***=----:.
    --::                          .:-:::. :?%SSS%%%?*+------:
    ---.                            .-===-+??*?*+***++=-----:
    --:                              ::--+-====+++*+++=-----:.
    -:                        ..:::-:--+===+=*+=??%**?=-----:.
                               .:-++*?%%??S%?S%%SS?%%?=-----:.


          ╔═══════════════════════════════════════════╗
          ║                                           ║
          ║          "Do you like our owl?"           ║
          ║                                           ║
          ║                     "It's artificial?"    ║
          ║                                           ║
          ║          "Of course it is."               ║
          ║                                           ║
          ║                     "Must be expensive."  ║
          ║                                           ║
          ║          "Very."                          ║
          ║                                           ║
          ╚═══════════════════════════════════════════╝

                          — Blade Runner, 1982


-->` }} style={{ display: 'none' }} />
        <ErrorBoundary>
          <AuthProvider>
            {children}
            <Footer />
            <Toaster theme="dark" />
          </AuthProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
