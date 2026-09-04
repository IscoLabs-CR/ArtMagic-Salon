import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Config del salón (tenant) en la base multitenant compartida. Cada despliegue
 * sirve UN salón — identificado por NEXT_PUBLIC_SALON_SLUG — así que la config se
 * trae UNA vez del RPC público `get_salon_public` y se cachea por request. Los
 * server components la pasan a los client components como prop (es serializable).
 *
 * Fuente de verdad: la base (salons / salon_categories / salon_services /
 * salon_hours). Cambiar un precio/horario NO requiere redeploy.
 */

export const SALON_SLUG = process.env.NEXT_PUBLIC_SALON_SLUG ?? "art-magic-salon";

export interface SalonBarber {
  id: string;
  name: string;
  /** Especialidad, bajo el nombre en el wizard ("Estilista y maquillista").
   *  null en los salones que no la cargaron. */
  role: string | null;
  displayOrder: number;
  /** Servicios que ESTA estilista realiza (slugs). Solo tiene sentido cuando el
   *  salón usa catálogo por estilista: si `perBarberServices` es false viene
   *  vacío para todas y hay que ignorarlo. Usar `servicesForBarber`. */
  serviceSlugs: string[];
}

export interface SalonCategory {
  slug: string;
  label: string;
  displayOrder: number;
}

export interface SalonService {
  slug: string;
  label: string;
  category: string; // category slug
  priceCRC: number | null; // null = sin precio; la UI no muestra la línea
  description: string;
  durationMin: number; // largo del bloque de la cita (múltiplo de 30)
  displayOrder: number;
  /** Servicio interno: NO se ofrece en el sitio público. Son los tratamientos
   *  largos que la clienta coordina por teléfono y que solo la administradora
   *  agenda desde el panel. `book_appointment` también los rechaza para
   *  cualquier otro llamador, así que esconderlos no es la única defensa. */
  adminOnly: boolean;
  /** Este servicio puede pasar por encima del descanso (almuerzo). Para los
   *  tratamientos que no caben en ningún bloque del día — con almuerzo de
   *  12:00 a 1:00, uno de 5 h no entra ni en la mañana ni en la tarde. */
  ignoresBreak: boolean;
}

/** Servicio que NO se reserva en línea. Son los tratamientos largos (2:30 a 5 h)
 *  que el salón tiene que calzar a mano en la agenda; el wizard los anuncia en un
 *  aviso y le pide a la clienta que llame. Es solo el texto del aviso: la cita en
 *  sí la crea la administradora desde el panel, con el servicio `adminOnly` del
 *  catálogo que lleva el mismo nombre. */
export interface CallToBookService {
  label: string;
  durationMin: number;
}

export interface DayHours {
  openMin: number;
  closeMin: number;
  /** Franja de descanso (almuerzo) en minutos desde medianoche. null = sin
   *  descanso ese día. La base rechaza cualquier cita que la invada, así que la
   *  rejilla de espacios tiene que respetarla o el cliente elige una hora que
   *  después falla al confirmar. */
  breakStartMin?: number | null;
  breakEndMin?: number | null;
  /** Última hora de inicio permitida. Si viene, un servicio puede empezar hasta
   *  esa hora aunque termine después del cierre; si es null, tiene que terminar
   *  antes de cerrar. Mismo criterio que `book_appointment`. */
  lastStartMin?: number | null;
}

export interface SalonConfig {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  theme: Record<string, unknown>;
  maxBookingsPerSlot: number;
  /** Cuántos días hacia adelante puede agendar un cliente, contando hoy. Es el
   *  tope que frena las flechas del calendario. */
  bookingHorizonDays: number;
  /** ¿Cada estilista tiene su propio catálogo? Cuando es false —salones donde
   *  todas hacen de todo— los `serviceSlugs` vienen vacíos y NO significan "esta
   *  estilista no hace nada": significan que la restricción no aplica. */
  perBarberServices: boolean;
  /** Teléfono del salón, para el botón de llamar del aviso. null = no cargado,
   *  y entonces el aviso se muestra sin botón. Sale de `theme.phone`. */
  phone: string | null;
  /** Servicios que hay que coordinar por teléfono (`theme.call_to_book`).
   *  Vacío = no se muestra ningún aviso. */
  callToBook: CallToBookService[];
  barbers: SalonBarber[];
  categories: SalonCategory[];
  services: SalonService[];
  hoursByDow: (DayHours | null)[]; // índice 0..6 (Dom..Sáb); null = cerrado
}

// Forma cruda que devuelve el RPC get_salon_public (snake_case).
interface RawSalon {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  theme: Record<string, unknown> | null;
  max_bookings_per_slot: number;
  per_barber_services: boolean;
  barbers: {
    id: string;
    name: string;
    role: string | null;
    display_order: number;
    service_slugs: string[] | null;
  }[];
  categories: { slug: string; label: string; display_order: number }[];
  services: {
    slug: string;
    label: string;
    category: string;
    price_crc: number | null;
    description: string;
    duration_min: number;
    display_order: number;
    // Ausentes si la base todavía no tiene las columnas (despliegue viejo):
    // se leen como false y el catálogo se comporta como siempre.
    admin_only?: boolean;
    ignores_break?: boolean;
  }[];
  hours: Record<
    string,
    {
      open_min: number;
      close_min: number;
      break_start_min: number | null;
      break_end_min: number | null;
      last_start_min: number | null;
    }
  >;
}

/** Lee un entero del `theme` jsonb del salón, con respaldo si no viene. */
function themeInt(
  theme: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = theme[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Lee un texto del `theme`. Vacío o de otro tipo cuenta como no cargado. */
function themeText(
  theme: Record<string, unknown>,
  key: string,
): string | null {
  const v = theme[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Lee `theme.call_to_book`. El `theme` es jsonb libre —lo edita una persona a
 * mano en la base—, así que cada elemento se valida y los que no cumplen se
 * descartan en vez de romper la página de reservas.
 */
function themeCallToBook(theme: Record<string, unknown>): CallToBookService[] {
  const raw = theme["call_to_book"];
  if (!Array.isArray(raw)) return [];
  const out: CallToBookService[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { label, duration_min: duration } = item as Record<string, unknown>;
    if (typeof label !== "string" || label.trim().length === 0) continue;
    out.push({
      label: label.trim(),
      durationMin:
        typeof duration === "number" && Number.isFinite(duration) && duration > 0
          ? duration
          : 0, // 0 = sin duración: el aviso muestra solo el nombre
    });
  }
  return out;
}

function shape(raw: RawSalon): SalonConfig {
  const hoursByDow: (DayHours | null)[] = Array.from({ length: 7 }, () => null);
  for (const [dow, h] of Object.entries(raw.hours ?? {})) {
    hoursByDow[Number(dow)] = {
      openMin: h.open_min,
      closeMin: h.close_min,
      breakStartMin: h.break_start_min,
      breakEndMin: h.break_end_min,
      lastStartMin: h.last_start_min,
    };
  }
  const theme = raw.theme ?? {};
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    timezone: raw.timezone,
    theme,
    maxBookingsPerSlot: raw.max_bookings_per_slot,
    bookingHorizonDays: themeInt(theme, "booking_horizon_days", 60),
    perBarberServices: raw.per_barber_services === true,
    phone: themeText(theme, "phone"),
    callToBook: themeCallToBook(theme),
    barbers: (raw.barbers ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      role: b.role ?? null,
      displayOrder: b.display_order,
      serviceSlugs: b.service_slugs ?? [],
    })),
    categories: (raw.categories ?? []).map((c) => ({
      slug: c.slug,
      label: c.label,
      displayOrder: c.display_order,
    })),
    services: (raw.services ?? []).map((s) => ({
      slug: s.slug,
      label: s.label,
      category: s.category,
      priceCRC: s.price_crc,
      description: s.description,
      durationMin: s.duration_min,
      displayOrder: s.display_order,
      adminOnly: s.admin_only === true,
      ignoresBreak: s.ignores_break === true,
    })),
    hoursByDow,
  };
}

/**
 * Trae la config del salón de este despliegue. Cacheada por request (React.cache)
 * para que múltiples server components no repitan el fetch. Lanza si el slug no
 * existe (mala configuración del deploy).
 */
export const getSalonConfig = cache(async (): Promise<SalonConfig> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_salon_public", {
    p_slug: SALON_SLUG,
  });
  if (error || !data) {
    throw new Error(
      `No se pudo cargar la configuración del salón "${SALON_SLUG}". ` +
        `¿Existe ese slug en la base? ${error?.message ?? ""}`,
    );
  }
  return shape(data as RawSalon);
});
