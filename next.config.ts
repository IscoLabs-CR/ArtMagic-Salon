import type { NextConfig } from "next";

// Cabeceras de seguridad de defensa en profundidad, en todas las rutas.
// La Content-Security-Policy NO va acá: la arma `src/proxy.ts`, porque lleva un
// nonce distinto por request y eso no se puede expresar en una cabecera estática.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // Evita que el navegador filtre a otros orígenes recursos de esta ventana.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

// X-Frame-Options y HSTS solo en producción: las extensiones de "mobile preview"
// cargan la app en un iframe/webview y con DENY se ven en blanco, y HSTS sobre
// http://localhost obligaría al navegador a forzar https en local.
const prodOnlyHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // Don't advertise the framework/version to attackers.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Las básicas van SIEMPRE (antes solo se enviaban en producción, así que
        // en dev no se detectaba ninguna regresión de cabeceras).
        source: "/:path*",
        headers: isProd ? [...securityHeaders, ...prodOnlyHeaders] : securityHeaders,
      },
      {
        // El service worker no debe cachearse, para que el navegador siempre
        // tome la última versión y controle todo el sitio (scope "/").
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
