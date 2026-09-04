import { type NextRequest } from "next/server";
import { buildAppointmentICS } from "@/lib/calendar";
import { getSalonConfig } from "@/lib/salon";

/**
 * Sirve la cita como archivo iCalendar. Existe porque iOS solo entrega un evento
 * a la app Calendario si llega por HTTP con `Content-Type: text/calendar` y
 * `Content-Disposition: inline`; un data: URI con `download` (lo que hacíamos
 * antes) termina como archivo suelto en Descargas y nunca abre el calendario.
 *
 * Los datos del evento viajan en el query string; el nombre y el slug del salón
 * los pone el server desde la config del despliegue.
 *
 * SEGURIDAD — esta ruta es pública y sin sesión, y refleja parámetros del
 * request en el archivo que devuelve:
 *   * el texto se corta y se limpia acá, y `buildAppointmentICS` lo escapa
 *     (`escICS` / `safeUid`) antes de armar el .ics;
 *   * se valida TODO antes de tocar la base, para que un request basura no
 *     dispare el RPC `get_salon_public`;
 *   * la ventana de fechas se acota, así el .ics no puede pedir un evento en el
 *     año 9999 ni con duración absurda.
 */

/** Tope de caracteres por campo de texto. Un nombre/servicio real no se acerca. */
const MAX_TEXT = 120;

/** Duración máxima de una cita, en horas. Corta valores disparatados. */
const MAX_HOURS = 24;

/** Ventana permitida alrededor de hoy, en días (pasado y futuro). */
const MAX_DAYS_AWAY = 400;

/**
 * Recorta un campo de texto del query string: sin caracteres de control y con
 * largo acotado. El escape de iCalendar lo hace `buildAppointmentICS`.
 */
function text(value: string | null, fallback = ""): string {
  const raw = (value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  return (raw || fallback).slice(0, MAX_TEXT);
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;

  const start = new Date(q.get("inicio") ?? "");
  const end = new Date(q.get("fin") ?? "");

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return new Response("Falta la fecha de la cita.", { status: 400 });
  }

  // El evento tiene que durar algo y no ser eterno.
  const ms = end.getTime() - start.getTime();
  if (ms <= 0 || ms > MAX_HOURS * 3_600_000) {
    return new Response("La duración de la cita no es válida.", { status: 400 });
  }

  // Y tiene que caer cerca de hoy: nada de eventos en el año 9999.
  const daysAway = Math.abs(start.getTime() - Date.now()) / 86_400_000;
  if (daysAway > MAX_DAYS_AWAY) {
    return new Response("La fecha de la cita está fuera de rango.", {
      status: 400,
    });
  }

  // Recién ahora se toca la base: los requests inválidos ya se rechazaron.
  const salon = await getSalonConfig();

  const ics = buildAppointmentICS({
    id: text(q.get("id")) || null,
    serviceLabel: text(q.get("servicio"), "Cita"),
    shopName: salon.name,
    slug: salon.slug,
    stylistName: text(q.get("estilista")),
    clientName: text(q.get("nombre")),
    start,
    end,
  });

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="cita.ics"',
      "Cache-Control": "no-store",
      // Nada de adivinar tipos sobre una respuesta con datos del cliente.
      "X-Content-Type-Options": "nosniff",
      // OJO: acá NO se agregan más cabeceras. iOS entrega el archivo a la app
      // Calendario o lo baja a Descargas según lo que traiga la respuesta, y
      // con `X-Robots-Tag`/`Referrer-Policy: no-referrer` (y la CSP, que se
      // saca en el matcher de `src/proxy.ts`) terminaba como descarga: el
      // cliente veía "cita.ics" en Archivos y el calendario nunca se abría.
      // El .ics no ejecuta nada ni enlaza a ningún lado, así que la protección
      // real de esta ruta es la validación del query string de arriba.
    },
  });
}
