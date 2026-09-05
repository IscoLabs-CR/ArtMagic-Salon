import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import type {
  SalonConfig,
  SalonService,
  SalonBarber,
  DayHours,
} from "@/lib/salon";

/**
 * Lógica de agenda compartida por el wizard del cliente y el panel del barbero.
 * TODA la config (servicios, horario, categorías, zona, tope por espacio) llega
 * desde la base vía `SalonConfig` (RPC get_salon_public) — nada quemado. El
 * razonamiento de reloj de pared usa la zona del salón; los instantes absolutos
 * (Date / timestamptz) se usan para guardar.
 *
 * Duración por servicio + tope por espacio cubren ambos modelos:
 *   - barbería: cortes de 30/60/90 min, 1 por espacio;
 *   - salón:   bloque de 30 min, N por espacio.
 */

export const SLOT_STEP_MIN = 30; // granularidad de la rejilla

/* --------------------------------------------------------------- precios */

/** Miles con punto, como se escriben los colones en Costa Rica (₡10.000). Se
 *  formatea a mano y no con `toLocaleString`, porque el separador que elige el
 *  ICU del servidor y el del navegador pueden diferir y romper la hidratación. */
export function formatCRC(amount: number): string {
  const digits = Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `₡${digits}`;
}

/** Etiqueta de precio, o null cuando el servicio no tiene precio cargado. Los
 *  salones que trabajan por cotización no muestran ninguna línea de precio, así
 *  que cada lugar que la pinta tiene que omitirla al recibir null. Si mañana se
 *  cargan los montos en la base, vuelven solos — sin redeploy. */
export function priceLabel(s: SalonService): string | null {
  return s.priceCRC == null ? null : formatCRC(s.priceCRC);
}

/** ¿Este salón trabaja con precios? Si ningún servicio tiene monto, la UI
 *  esconde también los totales (el panel de ingresos mostraría "₡0 de ₡0"). */
export function hasPrices(config: SalonConfig): boolean {
  return config.services.some((s) => s.priceCRC != null);
}

/* -------------------------------------------------------------- servicios */

export function getService(
  config: SalonConfig,
  slug: string,
): SalonService | undefined {
  return config.services.find((s) => s.slug === slug);
}

/** Quién está mirando el catálogo. Los servicios `adminOnly` (tratamientos
 *  largos que se coordinan por teléfono) SOLO salen con `admin: true`, y esa
 *  vista es el panel de la administradora. El valor por defecto es la vista
 *  pública a propósito: quien no diga nada obtiene el catálogo del cliente. */
export interface CatalogView {
  admin?: boolean;
}

/**
 * Servicios que realiza una estilista. En los salones donde todas hacen de todo
 * (`perBarberServices` en false) devuelve el catálogo completo — que es como
 * funcionó siempre. Con catálogo por estilista, solo los suyos: la base rechaza
 * cualquier reserva del par equivocado, así que ofrecerlos sería mentirle al
 * cliente. Sin estilista elegida todavía, el catálogo completo.
 *
 * Los `adminOnly` quedan fuera salvo que se pida la vista de admin.
 */
export function servicesForBarber(
  config: SalonConfig,
  barber: SalonBarber | null,
  view: CatalogView = {},
): SalonService[] {
  const visible = view.admin
    ? config.services
    : config.services.filter((s) => !s.adminOnly);
  if (!config.perBarberServices || !barber) return visible;
  return visible.filter((s) => barber.serviceSlugs.includes(s.slug));
}

export function servicesByCategory(
  config: SalonConfig,
  categorySlug: string,
  barber: SalonBarber | null = null,
  view: CatalogView = {},
): SalonService[] {
  return servicesForBarber(config, barber, view).filter(
    (s) => s.category === categorySlug,
  );
}

/* --------------------------------------------------------------- horario */

/** Ventana más amplia de la semana (menor apertura / mayor cierre). Respaldo para
 *  la UI que necesita límites aunque el día caiga cerrado (p. ej. bloquear horario). */
export function hoursWindow(config: SalonConfig): DayHours {
  const open = config.hoursByDow
    .filter((h): h is DayHours => h != null)
    .map((h) => h.openMin);
  const close = config.hoursByDow
    .filter((h): h is DayHours => h != null)
    .map((h) => h.closeMin);
  return {
    openMin: open.length ? Math.min(...open) : 480,
    closeMin: close.length ? Math.max(...close) : 1080,
  };
}

/* ----------------------------------------------------------------- slots */

/** Por qué un espacio NO se puede tomar. Con servicios cortos daba igual —el
 *  espacio se veía tachado y listo—; con los largos, la administradora necesita
 *  poder explicarle a la clienta si el problema es una cita encima, un bloqueo o
 *  que la hora ya pasó. */
export type SlotBlockReason = "past" | "blocked" | "taken";

export interface Slot {
  startMin: number; // minutos desde medianoche (hora local del salón)
  label: string; // ej. "9:00 a.m."
  start: Date; // instante absoluto (UTC)
  end: Date; // instante absoluto (UTC), start + duración del servicio
  available: boolean;
  reason: SlotBlockReason | null; // null cuando está disponible
}

// Una fila ocupada del día. Un "block" del barbero bloquea el espacio por sí
// solo; las reservas solo lo bloquean cuando se juntan maxBookingsPerSlot.
export interface BusyRow {
  start: Date;
  end: Date;
  kind: "booking" | "block";
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Hora de pared en reloj de 12 h, con el meridiano aparte: la UI compacta (los
 *  espacios del wizard, la columna de la agenda) lo pinta más chico que la hora. */
export interface Clock12 {
  time: string; // "10:00"
  meridiem: string; // "a.m." | "p.m."
}

export function minutesToClock(min: number): Clock12 {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return {
    time: `${h}:${m.toString().padStart(2, "0")}`,
    meridiem: h24 < 12 ? "a.m." : "p.m.",
  };
}

/** Reloj de 12 h ("8:00 a.m."), que es como se lee la hora en Costa Rica. */
export function minutesToLabel(min: number): string {
  const { time, meridiem } = minutesToClock(min);
  return `${time} ${meridiem}`;
}

/** Duración larga en palabras, con la convención de la clienta: "3 horas",
 *  "2:30 h", "45 min". Se usa en el aviso de servicios que van por teléfono,
 *  donde "180 min" se lee peor que "3 horas". */
export function formatDuration(min: number): string {
  if (min <= 0) return "";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return h === 1 ? "1 hora" : `${h} horas`;
  return `${h}:${m.toString().padStart(2, "0")} h`;
}

/** Día de la semana de una fecha YYYY-MM-DD (0 = Domingo .. 6 = Sábado). */
export function dowFromDateStr(dateStr: string): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** Horario de trabajo de un día calendario, o null si el salón cierra. */
export function dayHours(config: SalonConfig, dateStr: string): DayHours | null {
  return config.hoursByDow[dowFromDateStr(dateStr)] ?? null;
}

/** true cuando el salón está cerrado ese día. */
export function isClosedDay(config: SalonConfig, dateStr: string): boolean {
  return dayHours(config, dateStr) == null;
}

/** Instante absoluto para una hora de pared local del salón en un día dado. */
export function shopInstant(
  dateStr: string,
  minutesFromMidnight: number,
  tz: string,
): Date {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  const hh = h.toString().padStart(2, "0");
  const mm = m.toString().padStart(2, "0");
  return fromZonedTime(`${dateStr}T${hh}:${mm}:00`, tz);
}

/** Largo del bloque que ocupa un servicio. Sin servicio elegido todavía, una
 *  casilla de la rejilla. */
export function serviceDuration(service: SalonService | null): number {
  return service?.durationMin ?? SLOT_STEP_MIN;
}

/**
 * ¿Cabe este servicio empezando a esa hora, ese día? Aplica el MISMO criterio
 * que la base (`enforce_booking_rules` / `book_appointment`): día abierto,
 * dentro del horario, sin invadir el descanso y alineado a la rejilla. Vive acá
 * una sola vez para que la rejilla del wizard y el modal de cambiar servicio no
 * lleguen a una conclusión distinta de la del servidor.
 *
 * `service.ignoresBreak` levanta la regla del descanso, igual que en la base:
 * un tratamiento de 5 h no cabe ni en la mañana ni en la tarde de un día con
 * almuerzo, así que se atiende de corrido.
 */
export function fitsInHours(
  config: SalonConfig,
  dateStr: string,
  startMin: number,
  service: SalonService | null,
): boolean {
  const hours = dayHours(config, dateStr);
  if (!hours) return false; // el salón cierra ese día
  if (startMin < hours.openMin) return false;
  if ((startMin - hours.openMin) % SLOT_STEP_MIN !== 0) return false;
  const endMin = startMin + serviceDuration(service);
  // Con `lastStartMin` el servicio puede empezar hasta esa hora aunque termine
  // después del cierre; sin él, tiene que caber completo antes de cerrar.
  if (hours.lastStartMin != null) {
    if (startMin > hours.lastStartMin) return false;
  } else if (endMin > hours.closeMin) return false;
  // El descanso (almuerzo) no es "ocupado" sino fuera de horario.
  if (
    !service?.ignoresBreak &&
    hours.breakStartMin != null &&
    hours.breakEndMin != null &&
    startMin < hours.breakEndMin &&
    endMin > hours.breakStartMin
  ) {
    return false;
  }
  return true;
}

/**
 * Cada hora de inicio en la rejilla de 30 min dentro del horario. Un espacio está
 * disponible si es futuro, no cae en un "block", y tiene menos de
 * maxBookingsPerSlot reservas superpuestas. El fin del espacio usa la DURACIÓN del
 * servicio elegido, así un corte de 60 min ocupa dos casillas de 30.
 */
export function generateDaySlots(
  config: SalonConfig,
  dateStr: string,
  service: SalonService | null,
  busy: BusyRow[] = [],
  now: Date = new Date(),
): Slot[] {
  const hours = dayHours(config, dateStr);
  if (!hours) return [];
  const dur = serviceDuration(service);
  const slots: Slot[] = [];
  // Mismo criterio que `book_appointment` en la base: con `lastStartMin` el
  // servicio puede arrancar hasta esa hora aunque termine después del cierre;
  // sin él, tiene que caber completo antes de cerrar.
  const lastStart =
    hours.lastStartMin != null ? hours.lastStartMin : hours.closeMin - dur;
  for (let m = hours.openMin; m <= lastStart; m += SLOT_STEP_MIN) {
    // Lo que no cabe (se pasa del cierre, cae en el almuerzo) ni se ofrece: no
    // es un espacio "ocupado" sino fuera de horario. Sin esto la base rechaza la
    // reserva recién al confirmar, sin explicación para el cliente.
    if (!fitsInHours(config, dateStr, m, service)) continue;
    const start = shopInstant(dateStr, m, config.timezone);
    const end = new Date(start.getTime() + dur * 60_000);
    const notPast = start.getTime() > now.getTime();
    const blocked = busy.some(
      (b) => b.kind === "block" && overlaps(start, end, b.start, b.end),
    );
    const bookingCount = busy.reduce(
      (n, b) =>
        n +
        (b.kind === "booking" && overlaps(start, end, b.start, b.end) ? 1 : 0),
      0,
    );
    // El orden importa: lo que se le muestra a la administradora es el primer
    // motivo real. Una hora pasada no se explica como "ocupada".
    const reason: SlotBlockReason | null = !notPast
      ? "past"
      : blocked
        ? "blocked"
        : bookingCount >= config.maxBookingsPerSlot
          ? "taken"
          : null;
    slots.push({
      startMin: m,
      label: minutesToLabel(m),
      start,
      end,
      available: reason === null,
      reason,
    });
  }
  return slots;
}

/**
 * Por qué un día no ofrece NINGÚN espacio para el servicio elegido. Con los
 * servicios cortos alcanzaba con "sin horarios disponibles"; con los largos
 * (3–5 h) la administradora necesita saber si la agenda ya está ocupada o si el
 * servicio simplemente no entra en el horario de ese día — son dos problemas con
 * salidas distintas (mover de día vs. correr la otra cita).
 *
 * Devuelve null cuando sí hay al menos un espacio libre.
 */
export type NoSlotsReason =
  | "closed" // el salón no abre ese día
  | "does-not-fit" // el servicio no entra en el horario (largo, o choca con el almuerzo)
  | "past" // el día es hoy y ya pasaron todas las horas de inicio
  | "blocked" // la estilista tiene el día bloqueado (vacaciones, día libre)
  | "taken"; // hay citas encima de todos los espacios

export function noSlotsReason(
  config: SalonConfig,
  dateStr: string,
  slots: Slot[],
): NoSlotsReason | null {
  if (isClosedDay(config, dateStr)) return "closed";
  if (slots.some((s) => s.available)) return null;
  // La rejilla vacía significa que ninguna hora de inicio del día aguanta el
  // largo del servicio: no es que esté ocupado, es que no cabe.
  if (slots.length === 0) return "does-not-fit";
  const live = slots.filter((s) => s.reason !== "past");
  if (live.length === 0) return "past";
  if (live.every((s) => s.reason === "blocked")) return "blocked";
  return "taken";
}

/* -------------------------------------------------------- fechas / zonas */

/** Minutos desde medianoche de un instante, en hora de pared del salón. Es la
 *  unidad en la que razonan el horario, el descanso y `fitsInHours`. */
export function shopMinutes(d: Date | string, tz: string): number {
  const [h, m] = formatInTimeZone(new Date(d), tz, "HH:mm")
    .split(":")
    .map(Number);
  return h * 60 + m;
}

/** Hora de pared de un instante en la zona del salón, con el meridiano aparte. */
export function shopClock(d: Date | string, tz: string): Clock12 {
  return minutesToClock(shopMinutes(d, tz));
}

/** Un instante como hora del salón en reloj de 12 h ("8:00 a.m."). */
export function formatShopTime(d: Date | string, tz: string): string {
  const { time, meridiem } = shopClock(d, tz);
  return `${time} ${meridiem}`;
}

/** Fecha de hoy (YYYY-MM-DD) en la zona del salón. */
export function shopToday(tz: string): string {
  return formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
}

const WEEKDAYS_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const WEEKDAYS_FULL = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];
const MONTHS_SHORT = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];
const MONTHS_FULL = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function addDaysStr(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export interface DateParts {
  weekdayShort: string;
  weekdayFull: string;
  day: number;
  monthShort: string;
  monthFull: string;
  year: number;
  dow: number;
}

export function dateParts(dateStr: string): DateParts {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return {
    weekdayShort: WEEKDAYS_SHORT[dow],
    weekdayFull: WEEKDAYS_FULL[dow],
    day: d,
    monthShort: MONTHS_SHORT[mo - 1],
    monthFull: MONTHS_FULL[mo - 1],
    year: y,
    dow,
  };
}

export function longDateLabel(dateStr: string): string {
  const p = dateParts(dateStr);
  return `${p.weekdayFull} ${p.day} de ${p.monthFull}`;
}

/* ------------------------------------------------------------------ meses */

export interface Month {
  year: number;
  month: number; // 1..12
}

export function monthOf(dateStr: string): Month {
  const [year, month] = dateStr.split("-").map(Number);
  return { year, month };
}

export function addMonths(m: Month, n: number): Month {
  const idx = m.year * 12 + (m.month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Primer día del mes, como YYYY-MM-DD. */
export function monthStart(m: Month): string {
  return `${m.year}-${m.month.toString().padStart(2, "0")}-01`;
}

/** "julio 2026", para la cabecera del calendario. */
export function monthLabel(m: Month): string {
  return `${MONTHS_FULL[m.month - 1]} ${m.year}`;
}

/**
 * Celdas de la cuadrícula de un mes, EMPEZANDO EN LUNES. Los huecos previos al
 * día 1 y posteriores al último van en `null`, para que cada día caiga siempre
 * bajo su columna de día de la semana. El largo siempre es múltiplo de 7.
 */
export function monthGrid(m: Month): (string | null)[] {
  const first = monthStart(m);
  // dowFromDateStr da 0 = Domingo; la grilla arranca en lunes, así que se rota.
  const lead = (dowFromDateStr(first) + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; monthOf(d).month === m.month; d = addDaysStr(d, 1)) {
    cells.push(d);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/* ------------------------------------------------- ventana de reserva */

export interface BookingWindow {
  minDate: string; // primer día agendable (hoy, en zona del salón), inclusive
  maxDate: string; // último día agendable, inclusive
}

/** De hoy hasta el horizonte del salón (`theme.booking_horizon_days`, 60 por
 *  defecto). Es lo que frena las flechas del calendario. */
export function bookingWindow(config: SalonConfig): BookingWindow {
  const minDate = shopToday(config.timezone);
  return {
    minDate,
    maxDate: addDaysStr(minDate, Math.max(1, config.bookingHorizonDays) - 1),
  };
}

/**
 * El panel mira más lejos que el cliente a propósito: la dueña agenda por
 * teléfono y cierra las vacaciones de diciembre en agosto, antes de que nadie
 * pueda reservar esas fechas. ~13 meses, o sea siempre un poco más que el
 * horizonte del cliente: cualquier fecha agendable entra en la ventana del panel.
 */
export const ADMIN_HORIZON_DAYS = 400;

/** Ventana del panel para crear, mover o bloquear: de hoy hacia adelante. */
export function adminBookingWindow(tz: string): BookingWindow {
  const minDate = shopToday(tz);
  return { minDate, maxDate: addDaysStr(minDate, ADMIN_HORIZON_DAYS) };
}

/** Ventana para navegar la agenda: también hacia atrás, para revisar lo que ya pasó. */
export function agendaWindow(tz: string): BookingWindow {
  const today = shopToday(tz);
  return {
    minDate: addDaysStr(today, -ADMIN_HORIZON_DAYS),
    maxDate: addDaysStr(today, ADMIN_HORIZON_DAYS),
  };
}

/**
 * ¿Se puede elegir este día? Tiene que estar abierto y caer dentro de la ventana.
 * Las fechas YYYY-MM-DD ordenan lexicográficamente, así que alcanza con comparar
 * los strings — no hace falta parsearlas.
 */
export function isSelectableDay(
  config: SalonConfig,
  dateStr: string,
  win: BookingWindow,
): boolean {
  if (isClosedDay(config, dateStr)) return false;
  return dateStr >= win.minDate && dateStr <= win.maxDate;
}

/** Días ABIERTOS de un rango inclusivo. Los cerrados se omiten: ya son
 *  inasignables, no hace falta gastar un bloqueo en ellos. */
export function openDaysInRange(
  config: SalonConfig,
  fromStr: string,
  toStr: string,
): string[] {
  const days: string[] = [];
  for (let d = fromStr; d <= toStr; d = addDaysStr(d, 1)) {
    if (!isClosedDay(config, d)) days.push(d);
  }
  return days;
}

/** Cuántos días calendario abarca un rango inclusivo (28 jul → 4 ago = 8). */
export function rangeLengthDays(fromStr: string, toStr: string): number {
  const [y1, m1, d1] = fromStr.split("-").map(Number);
  const [y2, m2, d2] = toStr.split("-").map(Number);
  const from = Date.UTC(y1, m1 - 1, d1);
  const to = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((to - from) / 86_400_000) + 1;
}

export interface WeekRange {
  startStr: string; // Lunes (YYYY-MM-DD)
  endStr: string; // Lunes siguiente, exclusivo (YYYY-MM-DD)
  start: Date; // Lunes 00:00 en hora del salón (instante absoluto)
  end: Date; // Lunes siguiente 00:00 en hora del salón (instante absoluto)
}

/** La semana Lun–Dom (como instantes) que contiene `today` en hora del salón. */
export function weekRange(tz: string, today: string = shopToday(tz)): WeekRange {
  const { dow } = dateParts(today);
  const daysFromMonday = (dow + 6) % 7; // Lun=0, Mar=1, ... Dom=6
  const startStr = addDaysStr(today, -daysFromMonday);
  const endStr = addDaysStr(startStr, 7);
  return {
    startStr,
    endStr,
    start: shopInstant(startStr, 0, tz),
    end: shopInstant(endStr, 0, tz),
  };
}

/** Etiqueta legible de una semana, ej. "Lun 30 jun – Sáb 5 jul". */
export function weekRangeLabel(startStr: string): string {
  const a = dateParts(startStr);
  const b = dateParts(addDaysStr(startStr, 5)); // Sábado
  return `${a.weekdayShort} ${a.day} ${a.monthShort} – ${b.weekdayShort} ${b.day} ${b.monthShort}`;
}

/** Resumen de horario para la landing (agrupa días con el mismo horario), ej.
 *  ["Lun–Vie · 9:00 – 18:00", "Sáb · 8:00 – 14:30", "Cerrado Mar y Dom"]. */
export function weeklyHoursLabel(config: SalonConfig): string[] {
  const order = [1, 2, 3, 4, 5, 6, 0]; // Lun..Dom
  const groups: { days: number[]; hours: DayHours | null }[] = [];
  for (const d of order) {
    const h = config.hoursByDow[d] ?? null;
    const last = groups[groups.length - 1];
    const same =
      last &&
      ((last.hours == null && h == null) ||
        (last.hours != null &&
          h != null &&
          last.hours.openMin === h.openMin &&
          last.hours.closeMin === h.closeMin));
    if (same) last.days.push(d);
    else groups.push({ days: [d], hours: h });
  }
  const lines: string[] = [];
  const closed: number[] = [];
  for (const g of groups) {
    if (g.hours == null) {
      closed.push(...g.days);
      continue;
    }
    const label =
      g.days.length === 1
        ? WEEKDAYS_SHORT[g.days[0]]
        : `${WEEKDAYS_SHORT[g.days[0]]}–${WEEKDAYS_SHORT[g.days[g.days.length - 1]]}`;
    lines.push(
      `${label} · ${minutesToLabel(g.hours.openMin)} – ${minutesToLabel(g.hours.closeMin)}`,
    );
  }
  if (closed.length) lines.push(`Cerrado ${closed.map((d) => WEEKDAYS_SHORT[d]).join(" y ")}`);
  return lines;
}
