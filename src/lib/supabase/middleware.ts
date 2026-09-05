import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refresca la sesión de Supabase y cierra el paso al área de la estilista.
 *
 * `requestHeaders` son las cabeceras que se le pasan RÍO ARRIBA al render (las
 * trae el proxy con la Content-Security-Policy y el nonce). Tienen que viajar en
 * cada `NextResponse.next({ request })` — Next toma una foto de ellas en ese
 * momento, así que no sirve mutar el request después.
 */
export async function updateSession(
  request: NextRequest,
  requestHeaders: Headers,
) {
  let supabaseResponse = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          // `requestHeaders` se clonó ANTES de este refresco, así que su
          // cabecera `cookie` todavía lleva el token vencido. Hay que
          // reescribirla a mano: el patrón oficial de Supabase pasa `request`
          // (que se releé solo), pero acá se pasa un clon porque además carga
          // la CSP y el nonce.
          //
          // Sin esta línea el render recibe el token viejo, vuelve a refrescar
          // con el refresh token que Supabase ACABA de rotar y, si esa segunda
          // llamada cae fuera de la ventana de reúso (10 s — un arranque en
          // frío de Vercel se la come), Supabase lo toma como token robado y
          // borra la sesión en TODOS los dispositivos. Ese era el "se cierra
          // sola al volver a abrir la app".
          requestHeaders.set("cookie", request.cookies.toString());
          supabaseResponse = NextResponse.next({
            request: { headers: requestHeaders },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not run code between createServerClient and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isBarberArea =
    path.startsWith("/barbero") && !path.startsWith("/barbero/login");

  if (isBarberArea && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/barbero/login";
    // Un redirect no debe quedar cacheado: si se guarda, una sesión válida
    // posterior seguiría rebotando al login (y al revés en un CDN compartido).
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Cache-Control", "no-store");
    // Las cookies que Supabase escribió (acá casi siempre el borrado de una
    // sesión ya inválida) viajan en `supabaseResponse`, que este redirect
    // descarta. Si se pierden, el navegador se queda con cookies zombis y
    // vuelve a rebotar en el próximo intento.
    supabaseResponse.cookies
      .getAll()
      .forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  return supabaseResponse;
}
