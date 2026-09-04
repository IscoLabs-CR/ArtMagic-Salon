import type { Metadata, Viewport } from "next";
import { Oswald, Inter, Geist_Mono, Cormorant_Garamond } from "next/font/google";
import "./globals.css";

const oswald = Oswald({
  variable: "--font-oswald",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-mono-ticket",
  subsets: ["latin"],
});

// Serif elegante para el nombre del salón: el logotipo es dorado y de trazo
// alto contraste, y una condensada sola no lo acompaña.
const fancy = Cormorant_Garamond({
  variable: "--font-fancy",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Art & Magic Salon — Reserva tu cita",
  description:
    "Agendá tu cita con tu estilista de Art & Magic Salon. Elegí estilista, día y servicio, sin crear cuenta.",
  // iOS no toma todo del manifest: necesita el apple-touch-icon y el meta
  // apple-mobile-web-app para instalarse "a pantalla completa" y habilitar push.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Art & Magic Salon",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0b",
  // La app instalada en iOS usa barra de estado translúcida (`appleWebApp`
  // arriba): el contenido se dibuja DEBAJO del reloj y el notch. Con
  // `viewport-fit=cover` los `env(safe-area-inset-*)` dejan de valer 0 y las
  // cabeceras pueden reservar ese espacio (`pt-safe-top`).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${oswald.variable} ${inter.variable} ${mono.variable} ${fancy.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
