/**
 * Entrega la cita al calendario del cliente. La app NO descarga un archivo: cada
 * plataforma tiene su propia forma de abrir la ficha del evento ya rellena, y es
 * la que se usa aquí (ver `openInCalendar`).
 *
 * Los datos del salón (nombre, slug, servicio) vienen como parámetros: el módulo
 * no conoce ninguna config quemada (multitenant).
 */
export interface CalendarEvent {
  id: string | null;
  serviceLabel: string;
  shopName: string;
  slug: string; // dominio del UID del evento
  stylistName: string;
  clientName: string;
  start: Date;
  end: Date;
}

/** Date -> iCal UTC stamp, e.g. 2026-07-03T19:20:00.000Z -> 20260703T192000Z */
function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

/**
 * Escapa un valor de texto para iCalendar (RFC 5545 §3.3.11).
 *
 * SEGURIDAD: los caracteres de control NO se escapan, se ELIMINAN. Estos valores
 * llegan desde la query string de /api/cita.ics, y un CR/LF crudo cerraría la
 * línea actual del archivo: quien armara la URL podría agregar propiedades o
 * VEVENTs enteros al .ics (inyección iCalendar → invitación falsa servida desde
 * nuestro propio dominio). Se normalizan los saltos al escape legítimo "\n" y se
 * descarta el resto de los caracteres de control.
 */
function escICS(s: string): string {
  return s
    // CRLF / CR sueltos -> un solo LF, que abajo se convierte en el "\n" literal.
    .replace(/\r\n?/g, "\n")
    // Cualquier otro carácter de control se descarta (no es válido en iCal).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * UID del evento, restringido por lista blanca. El `id` llega por query string y
 * se interpola en una propiedad que NO admite el escape de texto de `escICS`,
 * así que acá se filtra en vez de escapar.
 */
function safeUid(id: string | null, slug: string): string {
  const local = (id ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  const domain = slug.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 80);
  return `${local || Date.now()}@${domain || "reservas"}`;
}

function eventTitle(ev: CalendarEvent): string {
  return `Cita en ${ev.shopName} — ${ev.serviceLabel}`;
}

function eventDescription(ev: CalendarEvent): string {
  return `Servicio: ${ev.serviceLabel}\nEstilista: ${ev.stylistName}\nA nombre de: ${ev.clientName}`;
}

/* ------------------------------------------------------------------- ics */

/**
 * Evento iCalendar con recordatorio 2 horas antes (VALARM TRIGGER:-PT2H). Lo
 * sirve la ruta /api/cita.ics con `Content-Type: text/calendar`; es el formato
 * que entiende la app Calendario de iOS.
 *
 * Todo valor que venga de afuera pasa por `escICS` (texto) o `safeUid` (UID);
 * `PRODID` usa el nombre del salón, que viene de la base, no del request.
 */
export function buildAppointmentICS(ev: CalendarEvent): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${escICS(ev.shopName)}//Reservas//ES`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${safeUid(ev.id, ev.slug)}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(ev.start)}`,
    `DTEND:${icsDate(ev.end)}`,
    `SUMMARY:${escICS(eventTitle(ev))}`,
    `DESCRIPTION:${escICS(eventDescription(ev))}`,
    `LOCATION:${escICS(ev.shopName)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Recordatorio: tu cita es en 2 horas",
    "TRIGGER:-PT2H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/* ------------------------------------------------------------- destinos */

/** URL propia que devuelve el .ics de esta cita (nombre y slug los pone el server). */
export function icsUrl(ev: CalendarEvent): string {
  const q = new URLSearchParams({
    servicio: ev.serviceLabel,
    estilista: ev.stylistName,
    nombre: ev.clientName,
    inicio: ev.start.toISOString(),
    fin: ev.end.toISOString(),
  });
  if (ev.id) q.set("id", ev.id);
  return `/api/cita.ics?${q}`;
}

/** Ficha de evento nueva en Google Calendar, ya rellena. */
export function googleCalendarUrl(ev: CalendarEvent): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: eventTitle(ev),
    dates: `${icsDate(ev.start)}/${icsDate(ev.end)}`,
    details: eventDescription(ev),
    location: ev.shopName,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/**
 * URL `intent:` de Android: abre la pantalla de "evento nuevo" del calendario
 * del teléfono con los datos cargados. Si el equipo no tiene una app que
 * responda al intent, el navegador cae al formulario web de Google Calendar.
 */
export function androidCalendarIntentUrl(ev: CalendarEvent): string {
  return [
    "intent:#Intent",
    "action=android.intent.action.INSERT",
    "type=vnd.android.cursor.dir/event",
    `S.title=${encodeURIComponent(eventTitle(ev))}`,
    `S.description=${encodeURIComponent(eventDescription(ev))}`,
    `S.eventLocation=${encodeURIComponent(ev.shopName)}`,
    `l.beginTime=${ev.start.getTime()}`,
    `l.endTime=${ev.end.getTime()}`,
    "B.allDay=false",
    `S.browser_fallback_url=${encodeURIComponent(googleCalendarUrl(ev))}`,
    "end",
  ].join(";");
}

/* ------------------------------------------------------------ plataforma */

/** iPhone/iPad — iPadOS 13+ se anuncia como Mac, lo delata la pantalla táctil. */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

/**
 * Abre el calendario del cliente con la cita ya cargada, sin descargar nada:
 *   - iOS: navega al .ics servido `inline`, que Safari entrega a la app
 *     Calendario (hoja "Añadir evento", con el recordatorio de 2 horas);
 *   - Android: intent de evento nuevo hacia el calendario instalado;
 *   - escritorio: ficha de Google Calendar en otra pestaña.
 */
export function openInCalendar(ev: CalendarEvent): void {
  if (isIOS()) {
    window.location.href = icsUrl(ev);
    return;
  }
  if (/Android/.test(navigator.userAgent)) {
    window.location.href = androidCalendarIntentUrl(ev);
    return;
  }
  window.open(googleCalendarUrl(ev), "_blank", "noopener,noreferrer");
}
