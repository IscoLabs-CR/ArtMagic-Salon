"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type {
  SalonConfig,
  SalonBarber,
  SalonService,
  CallToBookService,
} from "@/lib/salon";
import { type CalendarEvent, icsUrl, openInCalendar } from "@/lib/calendar";
import MonthCalendar from "@/components/MonthCalendar";
import {
  type Slot,
  type BusyRow,
  getService,
  generateDaySlots,
  bookingWindow,
  isSelectableDay,
  longDateLabel,
  minutesToClock,
  formatDuration,
  priceLabel,
  servicesByCategory,
  servicesForBarber,
} from "@/lib/booking";

/** Tope de caracteres de los datos del cliente. La validación que MANDA es la de
 *  la base (este formulario es público y el RPC se puede llamar sin pasar por
 *  acá); esto corta el texto antes de enviarlo y evita payloads absurdos. */
const MAX_NAME = 80;
const MAX_PHONE = 25;

/**
 * Traduce el error del RPC a algo que se le pueda mostrar a un cliente.
 *
 * `book_appointment` levanta avisos pensados para la pantalla (p. ej. "Ese
 * espacio ya está ocupado") y esos se dejan pasar tal cual. Cualquier cosa que
 * huela a error interno de Postgres/PostgREST se reemplaza por un mensaje
 * genérico: en un formulario público, `error.message` crudo filtra nombres de
 * funciones, constraints, columnas y políticas.
 */
function friendlyBookingError(message: string): string {
  const GENERIC = "No se pudo confirmar la cita. Probá con otro horario.";
  if (!message) return GENERIC;
  const internal =
    /(violates|constraint|relation|column|function|schema|syntax|permission denied|duplicate key|null value|invalid input|does not exist|row-level security|policy|SQLSTATE|pg_|public\.|JWT)/i;
  if (internal.test(message)) return GENERIC;
  // Un aviso de negocio es corto y de una línea; si no, no lo es.
  if (message.length > 160 || /[\r\n]/.test(message)) return GENERIC;
  return message;
}

type Step = 0 | 1 | 2 | 3 | 4;
const ALL_STEPS: { index: Step; label: string }[] = [
  { index: 0, label: "Estilista" },
  { index: 1, label: "Fecha" },
  { index: 2, label: "Servicio" },
  { index: 3, label: "Hora" },
  { index: 4, label: "Datos" },
];

interface Confirmation {
  stylistName: string;
  dateStr: string;
  serviceLabel: string;
  servicePrice: string | null; // null cuando el servicio no tiene precio cargado
  timeLabel: string;
  name: string;
  start: Date;
  end: Date;
  id: string | null;
}

export default function Wizard({ config }: { config: SalonConfig }) {
  const barbers = config.barbers;
  // Con una sola estilista no hay nada que elegir: se preselecciona y se salta.
  const singleBarber = barbers.length === 1;
  const initialStep: Step = singleBarber ? 1 : 0;
  const visibleSteps = singleBarber
    ? ALL_STEPS.filter((s) => s.index !== 0)
    : ALL_STEPS;

  const [step, setStep] = useState<Step>(initialStep);
  const [barber, setBarber] = useState<SalonBarber | null>(
    singleBarber ? barbers[0] : null,
  );
  const [dateStr, setDateStr] = useState<string | null>(null);
  const [service, setService] = useState<string | null>(null); // slug
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Confirmation | null>(null);
  // El aviso de "estos van por teléfono" sale UNA vez por reserva, al entrar al
  // paso del servicio. Vuelve a salir si la clienta arranca otra cita.
  const [callNoticeSeen, setCallNoticeSeen] = useState(false);

  const serviceInfo: SalonService | null = service
    ? getService(config, service) ?? null
    : null;
  const bookWindow = bookingWindow(config);
  // Lo que ofrece la estilista elegida. En los salones donde todas hacen de
  // todo es el catálogo completo (ver `servicesForBarber`).
  const barberServices = servicesForBarber(config, barber);

  function selectBarber(b: SalonBarber) {
    setBarber(b);
    setDateStr(null);
    setService(null);
    setSlot(null);
    setError(null);
    setStep(1);
  }

  function selectDate(d: string) {
    // Además del día cerrado, frena las fechas pasadas y las que se pasan del
    // horizonte de reserva del salón.
    if (!isSelectableDay(config, d, bookWindow)) return;
    setDateStr(d);
    setService(null);
    setSlot(null);
    setError(null);
    setStep(2);
  }

  // Elegir la card del servicio no avanza: primero se ve el precio y la nota.
  function chooseService(slug: string) {
    setService(slug);
    setSlot(null);
    setError(null);
  }

  // Al continuar, se trae la carga del día (bloqueos + citas) y se generan los
  // horarios, respetando la duración del servicio y el tope de personas por hora.
  async function goToSlots() {
    if (!dateStr || !serviceInfo || !barber) return;
    setStep(3);
    setLoadingSlots(true);
    setError(null);
    const supabase = createClient();
    const { data, error: loadError } = await supabase.rpc("get_day_load", {
      p_slug: config.slug,
      p_barber_id: barber.id,
      p_date: dateStr,
    });
    if (loadError) {
      // No mostramos horarios como "libres" a ciegas si no pudimos traer la
      // carga real del día: eso dejaría reservar sobre un espacio ya ocupado
      // (fallaría recién al confirmar, sin explicación). Mejor vaciar la
      // rejilla y avisar.
      console.error("No se pudo cargar la disponibilidad del día:", loadError.message);
      setSlots([]);
      setError("No se pudo cargar la disponibilidad. Intentá de nuevo.");
      setLoadingSlots(false);
      return;
    }
    const busy: BusyRow[] = ((data ?? []) as {
      start_time: string;
      end_time: string;
      kind: string;
    }[]).map((r) => ({
      start: new Date(r.start_time),
      end: new Date(r.end_time),
      kind: r.kind === "block" ? "block" : "booking",
    }));
    setSlots(generateDaySlots(config, dateStr, serviceInfo, busy));
    setLoadingSlots(false);
  }

  function selectSlot(s: Slot) {
    if (!s.available) return;
    setSlot(s);
    setError(null);
    setStep(4);
  }

  async function confirm() {
    if (!barber || !slot || !serviceInfo || !dateStr) return;
    const cleanName = name.trim().slice(0, MAX_NAME);
    const cleanPhone = phone.trim().slice(0, MAX_PHONE);
    if (cleanName.length === 0) {
      setError("Escribí tu nombre para confirmar la cita.");
      return;
    }
    // El teléfono es obligatorio: es el único canal para avisarle a la clienta
    // si hay que mover o cancelar la cita.
    if (cleanPhone.length === 0) {
      setError("Escribí tu teléfono para confirmar la cita.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("book_appointment", {
      p_slug: config.slug,
      p_barber_id: barber.id,
      p_start: slot.start.toISOString(),
      p_service_slug: serviceInfo.slug,
      p_name: cleanName,
      p_phone: cleanPhone,
    });
    setSubmitting(false);
    if (error) {
      // El detalle crudo va a la consola, no a la pantalla: `error.message` de
      // PostgREST puede traer nombres de funciones, constraints o columnas, y
      // este formulario es público. Solo se muestran los avisos de negocio que
      // `book_appointment` levanta a propósito (ver `friendlyBookingError`).
      console.error("No se pudo confirmar la cita:", error.message);
      setError(friendlyBookingError(error.message));
      return;
    }
    setDone({
      stylistName: barber.name,
      dateStr,
      serviceLabel: serviceInfo.label,
      servicePrice: priceLabel(serviceInfo),
      timeLabel: slot.label,
      name: name.trim(),
      start: slot.start,
      end: slot.end,
      id: (data as string | null) ?? null,
    });
  }

  function reset() {
    setStep(initialStep);
    setBarber(singleBarber ? barbers[0] : null);
    setDateStr(null);
    setService(null);
    setSlots([]);
    setSlot(null);
    setName("");
    setPhone("");
    setError(null);
    setDone(null);
    setCallNoticeSeen(false);
  }

  if (done)
    return (
      <SuccessScreen
        data={done}
        shopName={config.name}
        slug={config.slug}
        onAgain={reset}
      />
    );

  return (
    <div className="flex-1">
      <BookingHeader shopName={config.name} />

      {/* Sale al entrar al paso del servicio, antes de que la clienta elija:
          los tratamientos largos no se reservan acá y conviene que lo sepa
          antes de recorrer la lista buscándolos. */}
      {step === 2 && !callNoticeSeen && config.callToBook.length > 0 && (
        <CallToBookNotice
          services={config.callToBook}
          phone={config.phone}
          onAccept={() => setCallNoticeSeen(true)}
        />
      )}

      <div className="mx-auto w-full max-w-2xl px-5 pb-[calc(4rem_+_env(safe-area-inset-bottom))]">
        <Stepper
          steps={visibleSteps}
          current={step}
          onGoTo={(s) => s <= step && setStep(s)}
        />

        <div className="mt-7">
          {step === 0 && (
            <Section title="¿Con quién querés tu cita?">
              <div className="grid gap-3">
                {barbers.length === 0 && (
                  <p className="text-cream/70">
                    No hay estilistas disponibles por ahora.
                  </p>
                )}
                {barbers.map((b) => (
                  <OptionRow
                    key={b.id}
                    active={barber?.id === b.id}
                    onClick={() => selectBarber(b)}
                    title={b.name}
                    subtitle={b.role ?? "Estilista"}
                  />
                ))}
              </div>
            </Section>
          )}

          {step === 1 && (
            <Section title="Elegí el día">
              <MonthCalendar
                config={config}
                value={dateStr}
                onChange={selectDate}
                window={bookWindow}
                tone="dark"
              />
            </Section>
          )}

          {step === 2 && dateStr && (
            <Section title="¿Qué servicio querés?" hint={longDateLabel(dateStr)}>
              {/* Cada estilista ofrece solo lo suyo: mostrarle al cliente algo
                  que esa persona no hace termina en un rechazo al confirmar. */}
              {barberServices.length === 0 && (
                <div className="rounded-2xl border border-line bg-paper-smoke/80 px-5 py-6 text-center backdrop-blur-3xl">
                  <p className="text-ink/75">
                    {barber?.name ?? "Esta estilista"} no tiene servicios
                    disponibles por ahora.
                  </p>
                  {!singleBarber && (
                    <button
                      type="button"
                      onClick={() => setStep(0)}
                      className="mt-4 inline-flex items-center justify-center rounded-full border border-brand px-5 py-2.5 font-display text-sm font-semibold uppercase tracking-wide text-brand transition-colors hover:bg-brand hover:text-white"
                    >
                      Elegir otra estilista
                    </button>
                  )}
                </div>
              )}

              <div className="grid gap-5">
                {config.categories.map((cat) => {
                  const items = servicesByCategory(config, cat.slug, barber);
                  if (items.length === 0) return null;
                  return (
                    <div key={cat.slug}>
                      <p className="mb-2 font-display text-[11px] uppercase tracking-[0.3em] text-cream/60">
                        {cat.label}
                      </p>
                      <div className="grid gap-2">
                        {items.map((s) => (
                          <ServiceCard
                            key={s.slug}
                            service={s}
                            active={service === s.slug}
                            onClick={() => chooseService(s.slug)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {serviceInfo && (
                <button
                  type="button"
                  onClick={goToSlots}
                  className="mt-7 inline-flex w-full items-center justify-center rounded-full bg-brand px-6 py-3.5 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep"
                >
                  Ver horarios
                </button>
              )}
            </Section>
          )}

          {step === 3 && (
            <Section
              title="Elegí tu horario"
              hint={
                dateStr && serviceInfo
                  ? `${longDateLabel(dateStr)} · ${serviceInfo.label}`
                  : undefined
              }
            >
              <SlotGrid
                slots={slots}
                loading={loadingSlots}
                selectedMin={slot?.startMin ?? null}
                onSelect={selectSlot}
                onBackToDate={() => setStep(1)}
              />
              {error && <ErrorNote>{error}</ErrorNote>}
            </Section>
          )}

          {step === 4 && barber && dateStr && serviceInfo && slot && (
            <Section title="Tus datos">
              <TicketSummary
                stylistName={barber.name}
                dateStr={dateStr}
                service={serviceInfo}
                timeLabel={slot.label}
              />

              <div className="mt-5 grid gap-4">
                <Field
                  label="Nombre"
                  required
                  value={name}
                  onChange={setName}
                  placeholder="Tu nombre"
                  autoFocus
                  maxLength={MAX_NAME}
                />
                <Field
                  label="Teléfono"
                  type="tel"
                  required
                  value={phone}
                  onChange={setPhone}
                  placeholder="Para confirmarte la cita"
                  maxLength={MAX_PHONE}
                />
              </div>

              {error && <ErrorNote>{error}</ErrorNote>}

              <button
                type="button"
                onClick={confirm}
                disabled={submitting}
                className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-brand px-6 py-4 font-display text-lg font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep disabled:opacity-60"
              >
                {submitting ? "Confirmando…" : "Confirmar cita"}
              </button>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- pieces */

function BookingHeader({ shopName }: { shopName: string }) {
  return (
    // `pt-safe-top`: en el iPhone con la app instalada la barra de estado es
    // translúcida y el contenido arranca debajo del reloj; sin este relleno la
    // cabecera pegajosa queda montada sobre él.
    <header className="sticky top-0 z-10 border-b border-line bg-paper/90 pt-safe-top backdrop-blur">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-5 py-3">
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-[#0b0b0b]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt={shopName}
              className="h-full w-full object-contain"
            />
          </span>
          {/* Nombres largos se recortan: si crecen, empujan "Cancelar" fuera de
              la pantalla en celular. */}
          <span className="truncate font-display text-lg font-semibold uppercase tracking-wide text-ink">
            {shopName}
          </span>
        </Link>
        <Link
          href="/"
          className="shrink-0 text-sm text-muted transition-colors hover:text-brand"
        >
          Cancelar
        </Link>
      </div>
    </header>
  );
}

function Stepper({
  steps,
  current,
  onGoTo,
}: {
  steps: { index: Step; label: string }[];
  current: number;
  onGoTo: (s: Step) => void;
}) {
  return (
    <nav className="mt-6" aria-label="Progreso de la reserva">
      <ol className="flex items-center gap-1.5">
        {steps.map(({ index, label }) => {
          const state =
            index < current
              ? "done"
              : index === current
                ? "current"
                : "upcoming";
          return (
            <li
              key={label}
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
            >
              <button
                type="button"
                onClick={() => onGoTo(index)}
                disabled={index > current}
                className={[
                  "h-1.5 w-full rounded-full transition-colors",
                  state === "upcoming" ? "bg-white/25" : "bg-gold",
                ].join(" ")}
                aria-label={label}
              />
              <span
                className={[
                  // Cinco rótulos repartidos en el ancho del teléfono. A 10px
                  // "Estilista" entra completo en su quinto de pantalla; el
                  // interletrado extra, que lo desbordaba, queda para sm+.
                  // `truncate` es la red por si el teléfono es más angosto.
                  "w-full truncate text-center text-[10px] font-medium uppercase sm:text-xs sm:tracking-wider",
                  state === "current"
                    ? "text-gold"
                    : state === "done"
                      ? "text-cream"
                      : "text-cream/50",
                ].join(" ")}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-tight text-cream">
        {title}
      </h1>
      {hint && <p className="mt-1 text-sm text-cream/70">{hint}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

// Card de servicio: precio y duración a la vista, sin dropdowns. La duración sí
// se muestra — en barbería no todos los cortes duran lo mismo, y el cliente
// necesita saber cuánto va a estar en la silla. El precio se omite entero en los
// salones que trabajan por cotización.
function ServiceCard({
  service,
  active,
  onClick,
}: {
  service: SalonService;
  active: boolean;
  onClick: () => void;
}) {
  const price = priceLabel(service);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        // Mismo vidrio esmerilado del card de la landing: estas tarjetas van
        // sobre el fondo de la marca, y en blanco sólido lo tapaban. La
        // seleccionada queda más opaca, que es lo que la separa del resto.
        "w-full rounded-xl border px-4 py-3 text-left backdrop-blur-3xl transition-colors",
        active
          ? "border-brand bg-brand-tint/85"
          : "border-line bg-paper-smoke/80 hover:border-brand/60 hover:bg-brand-tint/70",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words font-display text-sm font-semibold uppercase tracking-wide text-ink">
          {service.label}
        </span>
        {price && (
          <span
            className={[
              "shrink-0 rounded-full px-2.5 py-0.5 font-mono text-xs font-medium",
              active ? "bg-brand text-white" : "bg-brand-tint text-brand",
            ].join(" ")}
          >
            {price}
          </span>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-snug text-ink/75">
        {service.durationMin} min
        {service.description && ` · ${service.description}`}
      </p>
    </button>
  );
}

function OptionRow({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "group flex items-center justify-between rounded-2xl border px-5 py-4 text-left backdrop-blur-3xl transition-colors",
        active
          ? "border-brand bg-brand-tint/85"
          : "border-line bg-paper-smoke/80 hover:border-brand hover:bg-brand-tint/70",
      ].join(" ")}
    >
      <span className="min-w-0 break-words">
        <span className="block font-display text-lg font-semibold uppercase tracking-wide text-ink">
          {title}
        </span>
        {subtitle && (
          <span className="mt-0.5 block text-sm text-ink/75">{subtitle}</span>
        )}
      </span>
    </button>
  );
}

function SlotGrid({
  slots,
  loading,
  selectedMin,
  onSelect,
  onBackToDate,
}: {
  slots: Slot[];
  loading: boolean;
  selectedMin: number | null;
  onSelect: (s: Slot) => void;
  onBackToDate: () => void;
}) {
  if (loading) {
    return <p className="py-10 text-center text-cream/70">Cargando horarios…</p>;
  }

  const anyAvailable = slots.some((s) => s.available);

  if (slots.length === 0 || !anyAvailable) {
    return (
      <div className="rounded-2xl border border-white/15 bg-black/30 px-5 py-8 text-center">
        <p className="text-cream">No hay horarios disponibles para este día.</p>
        <button
          type="button"
          onClick={onBackToDate}
          className="mt-3 text-sm font-medium text-gold hover:text-gold/80"
        >
          Elegir otro día
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
      {slots.map((s) => {
        const selected = selectedMin === s.startMin;
        const clock = minutesToClock(s.startMin);
        if (!s.available) {
          return (
            <div
              key={s.startMin}
              aria-label={`${s.label} — no disponible`}
              className="flex flex-col items-center rounded-xl border border-white/12 bg-white/10 px-2 py-2.5 text-cream/45"
            >
              <span className="font-mono text-sm line-through">
                {clock.time}
                <span className="ml-0.5 font-sans text-[10px]">
                  {clock.meridiem}
                </span>
              </span>
              <span className="text-[10px] uppercase tracking-wide">
                No disp.
              </span>
            </div>
          );
        }
        return (
          <button
            key={s.startMin}
            type="button"
            onClick={() => onSelect(s)}
            className={[
              "flex flex-col items-center rounded-xl border px-2 py-2.5 transition-colors",
              selected
                ? "border-brand bg-brand text-white"
                : "border-brand/60 bg-brand-tint text-brand hover:bg-brand hover:text-white",
            ].join(" ")}
          >
            <span className="font-mono text-base font-medium">
              {clock.time}
              <span className="ml-0.5 font-sans text-[10px] font-normal">
                {clock.meridiem}
              </span>
            </span>
            <span className="text-[10px] uppercase tracking-wide opacity-80">
              Libre
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TicketSummary({
  stylistName,
  dateStr,
  service,
  timeLabel,
}: {
  stylistName: string;
  dateStr: string;
  service: SalonService;
  timeLabel: string;
}) {
  const price = priceLabel(service);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-paper">
      <div className="absolute inset-y-0 left-0 w-2 bg-brand" aria-hidden />
      {/* Dos columnas también en celular: `min-w-0` + `break-words` para que un
          servicio de nombre largo se parta en vez de estirar su columna. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-5 pl-6 [&>div]:min-w-0 [&_dd]:break-words sm:px-6 sm:pl-7">
        <SummaryItem label="Estilista" value={stylistName} />
        <SummaryItem label="Servicio" value={service.label} />
        <SummaryItem label="Día" value={longDateLabel(dateStr)} />
        <SummaryItem label="Hora" value={timeLabel} mono />
        {price && <SummaryItem label="Precio" value={price} mono />}
      </dl>
    </div>
  );
}

function SummaryItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-muted">
        {label}
      </dt>
      <dd
        className={[
          "mt-0.5 text-sm font-medium text-ink",
          mono ? "font-mono" : "",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required,
  autoFocus,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-cream">
        {label}
        {required && <span className="text-gold"> *</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxLength={maxLength}
        className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-brand"
      />
    </label>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 rounded-xl border border-brand/30 bg-brand-tint px-4 py-3 text-sm text-brand-deep">
      {children}
    </p>
  );
}

function SuccessScreen({
  data,
  shopName,
  slug,
  onAgain,
}: {
  data: Confirmation;
  shopName: string;
  slug: string;
  onAgain: () => void;
}) {
  const [showPrompt, setShowPrompt] = useState(true);
  const [added, setAdded] = useState(false);

  const event: CalendarEvent = {
    id: data.id,
    serviceLabel: data.serviceLabel,
    shopName,
    slug,
    stylistName: data.stylistName,
    clientName: data.name,
    start: data.start,
    end: data.end,
  };

  function addToCalendar() {
    openInCalendar(event);
    setAdded(true);
    setShowPrompt(false);
  }

  return (
    <main className="flex-1 grid place-items-center px-5 pb-[calc(3rem_+_env(safe-area-inset-bottom))] pt-[calc(3rem_+_env(safe-area-inset-top))]">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-gold text-[#171310]">
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>

        <h1 className="mt-5 font-display text-3xl font-bold uppercase tracking-tight text-cream">
          ¡Cita confirmada!
        </h1>
        <p className="mt-2 text-cream/75">
          Te esperamos, {data.name.split(" ")[0]}.
        </p>

        <div className="mt-7 overflow-hidden rounded-2xl border border-line bg-paper text-left">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-5 [&>div]:min-w-0 [&_dd]:break-words sm:px-6">
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted">
                Estilista
              </dt>
              <dd className="mt-0.5 text-sm font-medium text-ink">
                {data.stylistName}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted">
                Servicio
              </dt>
              <dd className="mt-0.5 text-sm font-medium text-ink">
                {data.serviceLabel}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted">
                Día
              </dt>
              <dd className="mt-0.5 text-sm font-medium text-ink">
                {longDateLabel(data.dateStr)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted">
                Hora
              </dt>
              <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                {data.timeLabel}
              </dd>
            </div>
            {data.servicePrice && (
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted">
                  Precio
                </dt>
                <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                  {data.servicePrice}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="mt-7 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => (added ? addToCalendar() : setShowPrompt(true))}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-6 py-3.5 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep"
          >
            {added ? "Abrir el calendario otra vez" : "Agregar a mi calendario"}
          </button>
          {added && (
            <p className="-mt-1 text-xs text-cream/70">
              ¿No se abrió tu calendario?{" "}
              <a
                href={icsUrl(event)}
                className="font-medium text-gold underline underline-offset-2"
              >
                Abrí el archivo de la cita
              </a>
              .
            </p>
          )}
          <button
            type="button"
            onClick={onAgain}
            className="inline-flex items-center justify-center rounded-full border border-white/25 px-6 py-3 text-sm font-medium text-cream transition-colors hover:border-gold hover:text-gold"
          >
            Reservar otra cita
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center py-1 text-sm text-cream/70 transition-colors hover:text-gold"
          >
            Volver al inicio
          </Link>
        </div>
      </div>

      {showPrompt && (
        <CalendarPrompt
          onAdd={addToCalendar}
          onDismiss={() => setShowPrompt(false)}
        />
      )}
    </main>
  );
}

/**
 * Aviso que sale al llegar al paso del servicio: la lista de tratamientos largos
 * que NO se reservan en línea y hay que coordinar por teléfono. No se cierra
 * tocando afuera —solo con "Aceptar"— porque es información que la clienta tiene
 * que ver antes de elegir; sí se cierra con Escape, para no dejar trampas de
 * teclado. La lista y el teléfono salen de la config del salón.
 */
function CallToBookNotice({
  services,
  phone,
  onAccept,
}: {
  services: CallToBookService[];
  phone: string | null;
  onAccept: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAccept();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onAccept]);

  return (
    <div className="animate-overlay-in fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="call-to-book-title"
        className="animate-drop-in max-h-[92dvh] w-full max-w-sm overflow-y-auto rounded-t-3xl border border-line bg-paper p-6 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl sm:pb-6"
      >
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-tint text-brand">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.4 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.8 2.1z" />
          </svg>
        </div>

        <h2
          id="call-to-book-title"
          className="mt-4 text-center font-display text-xl font-semibold uppercase tracking-tight text-ink"
        >
          Estos van por teléfono
        </h2>
        <p className="mt-2 text-center text-sm text-muted">
          Son tratamientos largos y necesitamos calzarlos en la agenda con vos.
          Para estos, <strong className="text-ink">llamá al salón</strong> y te
          confirmamos el espacio.
        </p>

        <ul className="mt-5 divide-y divide-line rounded-2xl border border-line bg-line/20">
          {services.map((s) => (
            <li
              key={s.label}
              className="flex items-baseline justify-between gap-3 px-4 py-2.5"
            >
              <span className="min-w-0 break-words text-sm font-medium text-ink">
                {s.label}
              </span>
              {s.durationMin > 0 && (
                <span className="shrink-0 font-mono text-xs text-muted">
                  {formatDuration(s.durationMin)}
                </span>
              )}
            </li>
          ))}
        </ul>

        <p className="mt-4 text-center text-xs text-muted">
          El resto de los servicios los podés reservar acá mismo.
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          {phone && (
            // El número va escrito en el botón a propósito: en computadora el
            // enlace `tel:` no hace nada, y así igual se puede anotar.
            <a
              href={`tel:${phone.replace(/[^\d+]/g, "")}`}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-brand px-6 py-3 font-display text-sm font-semibold uppercase tracking-wide text-brand transition-colors hover:bg-brand hover:text-white"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.4 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.8 2.1z" />
              </svg>
              Llamar al {phone}
            </a>
          )}
          <button
            type="button"
            onClick={onAccept}
            autoFocus
            className="inline-flex items-center justify-center rounded-full bg-brand px-6 py-3.5 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep"
          >
            Aceptar
          </button>
        </div>
      </div>
    </div>
  );
}

function CalendarPrompt({
  onAdd,
  onDismiss,
}: {
  onAdd: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-5"
      onClick={onDismiss}
    >
      <div
        className="max-h-[92dvh] w-full max-w-sm overflow-y-auto rounded-t-3xl border border-line bg-paper p-6 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))] text-center shadow-2xl sm:rounded-3xl sm:pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-tint text-brand">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </div>
        <h2 className="mt-4 font-display text-xl font-semibold uppercase tracking-tight text-ink">
          ¿Agregar al calendario?
        </h2>
        <p className="mt-2 text-sm text-muted">
          Se abre el calendario de tu teléfono con{" "}
          <strong className="text-ink">los datos de la cita ya cargados</strong>
          . Solo confirmá para guardarla.
        </p>
        <div className="mt-6 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center justify-center rounded-full bg-brand px-6 py-3.5 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep"
          >
            Agregar al calendario
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center justify-center py-2 text-sm font-medium text-muted transition-colors hover:text-brand"
          >
            Ahora no
          </button>
        </div>
      </div>
    </div>
  );
}
