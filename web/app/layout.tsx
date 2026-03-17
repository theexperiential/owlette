import type { Metadata } from "next";
import { Space_Grotesk, Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Footer } from "@/components/Footer";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Owlette - Always Watching",
  description: "Cloud-connected Windows process management system for TouchDesigner, digital signage, and media servers. Remote monitoring, deployment, and control across your entire fleet.",
  icons: {
    icon: '/owlette-icon.png',
    shortcut: '/owlette-icon.png',
    apple: '/owlette-icon.png',
  },
  openGraph: {
    title: "Owlette - Always Watching",
    description: "Cloud-connected Windows process management system for TouchDesigner, digital signage, and media servers. Remote monitoring, deployment, and control across your entire fleet.",
    url: "https://owlette.app",
    siteName: "Owlette",
    images: [
      {
        url: '/owlette-icon.png',
        width: 1024,
        height: 1024,
        alt: 'Owlette - Always Watching',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: "Owlette - Always Watching",
    description: "Cloud-connected Windows process management system for TouchDesigner, digital signage, and media servers. Remote monitoring, deployment, and control across your entire fleet.",
    images: ['/owlette-icon.png'],
  },
  metadataBase: new URL('https://owlette.app'),
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
        className={`${inter.variable} ${spaceGrotesk.variable} ${geistMono.variable} font-sans antialiased text-foreground`}
      >
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
