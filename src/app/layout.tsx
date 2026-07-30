import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Space_Grotesk } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { Agentation } from "agentation";
import { brandStyleOverride } from "@/lib/branding";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Agente WhatsApp",
  description: "Plataforma de inbox conversacional para WhatsApp con IA",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const brand = brandStyleOverride();

  return (
    <html lang="es" suppressHydrationWarning>
      {brand && (
        <head>
          {/* Inline so the brand tint lands on first paint, before hydration. */}
          <style dangerouslySetInnerHTML={{ __html: brand }} />
        </head>
      )}
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} ${spaceGrotesk.variable} font-body antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          {process.env.NODE_ENV === "development" && <Agentation />}
        </ThemeProvider>
      </body>
    </html>
  );
}
