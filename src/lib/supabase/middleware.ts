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
    return redirect;
  }

  return supabaseResponse;
}
