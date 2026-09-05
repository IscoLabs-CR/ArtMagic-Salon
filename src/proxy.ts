import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/** Rutas públicas que se saltean el refresco de sesión (ver el cuerpo del proxy). */
const NO_SESSION = new Set(["/sw.js", "/manifest.webmanifest"]);

/**
 * Next 16 renombró `middleware` → `proxy` (ver
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
 *
 * Hace dos cosas por request:
 *   1. arma el nonce y la Content-Security-Policy;
 *   2. refresca la sesión de Supabase y cierra el paso a /barbero sin login.
 *
 * OJO: el guardado de /barbero acá es la PRIMERA capa, no la única — la página
 * `src/app/barbero/page.tsx` vuelve a validar con `supabase.auth.getUser()`. Los
 * docs de Next lo piden explícitamente ("Always verify authentication and
 * authorization inside each Server Function rather than relying on Proxy
 * alone"), y encima cubre los bypass de proxy que aparecen de vez en cuando en
 * los avisos de seguridad de Next.
 */
export async function proxy(request: NextRequest) {
  // Nonce nuevo por request. Next lo lee del header CSP del request y lo pega
  // solo en sus propios <script> (runtime, bundles, estilos que genera él).
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  // Supabase se llama desde el navegador (REST + Realtime por WebSocket), así que
  // su origen tiene que estar en connect-src o el wizard y el panel dejan de
  // andar. Sale de la env var, no quemado, para no atar la CSP a un proyecto.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseOrigins = [supabaseUrl, supabaseUrl.replace(/^https:/, "wss:")]
    .filter(Boolean)
    .join(" ");

  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' + nonce: los scripts que Next inyecta quedan habilitados y
    // pueden cargar sus chunks, pero un <script> inyectado por un atacante no.
    // En dev React necesita 'unsafe-eval' para rearmar los stacks del server.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Sin nonce a propósito: si se pone uno, el navegador IGNORA 'unsafe-inline',
    // y hace falta para el `style={{ width }}` de la barra semanal del panel y
    // para los estilos inline que generan Tailwind/React.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // next/font descarga las tipografías en build y las sirve desde /_next.
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseOrigins}${isDev ? " ws: http://localhost:*" : ""}`,
    // El service worker de las notificaciones push (public/sw.js).
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Antiframing real (X-Frame-Options es el respaldo para navegadores viejos).
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  // Las cabeceras del request se pasan RÍO ARRIBA al render: de ahí Next saca el
  // nonce. Se clonan porque `request.headers` es de solo lectura.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-nonce", nonce);

  // El service worker y el manifest son archivos públicos: no necesitan sesión.
  // El navegador los pide JUNTO con la página al abrir la app, y tres refrescos
  // simultáneos del mismo refresh token es justo lo que rompe la sesión. Igual
  // pasan por acá para recibir la CSP.
  const needsSession = !NO_SESSION.has(request.nextUrl.pathname);

  const response = needsSession
    ? await updateSession(request, requestHeaders)
    : NextResponse.next({ request: { headers: requestHeaders } });

  // Y en la response, para que el navegador aplique la política.
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  matcher: [
    /*
     * Todas las rutas menos los assets estáticos y las imágenes. `/api` SÍ entra
     * (así no quedan huecos si mañana se agrega un endpoint con sesión), con una
     * excepción: `api/cita.ics`.
     *
     * Esa ruta se sirve SIN CSP a propósito. Es un archivo de texto que no
     * ejecuta nada ni carga subrecursos, así que la CSP no le suma seguridad; en
     * cambio, en el iPhone la respuesta con CSP terminaba como descarga en vez
     * de abrir la app Calendario. Saltearla además evita gastar un refresco de
     * sesión de Supabase en un endpoint público y sin login.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/cita\\.ics|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
