"use client";

import { useMemo, useState } from "react";
import type { SalonConfig } from "@/lib/salon";
import {
  type BookingWindow,
  type Month,
  addMonths,
  bookingWindow,
  dateParts,
  isClosedDay,
  isSelectableDay,
  longDateLabel,
  monthGrid,
  monthLabel,
  monthOf,
  monthStart,
  shopToday,
} from "@/lib/booking";

/**
 * Calendario de un mes con flechas para navegar. Lo usan los dos lados: el wizard
 * del cliente (ventana = hoy → horizonte del salón) y el panel del barbero para
 * elegir los extremos de un bloqueo largo (ventana más amplia).
 *
 * Un día se puede tocar solo si el salón abre ese día de la semana y la fecha cae
 * dentro de la ventana. Las flechas se apagan al llegar a los meses de los extremos.
 *
 * `allowClosed` levanta la primera condición: lo usa el navegador de la agenda,
 * donde la estilista sí necesita abrir un domingo para ver sus bloqueos. Los días
 * cerrados quedan atenuados pero clickeables.
 *
 * `tone` decide sobre qué fondo se dibuja: "dark" para el fondo de la marca del
 * wizard, "light" (por defecto) para el crema del panel de la estilista.
 */

type Tone = "light" | "dark";

// La grilla arranca en lunes, como se lee un calendario en Costa Rica.
const WEEKDAY_HEADS = ["L", "M", "M", "J", "V", "S", "D"];

export default function MonthCalendar({
  config,
  value,
  onChange,
  window: win,
  allowClosed = false,
  tone = "light",
}: {
  config: SalonConfig;
  value: string | null;
  onChange: (dateStr: string) => void;
  /** Por defecto, la ventana del cliente. */
  window?: BookingWindow;
  /** Deja tocar también los días en que el salón no abre. */
  allowClosed?: boolean;
  tone?: Tone;
}) {
  const w = win ?? bookingWindow(config);
  const today = shopToday(config.timezone);

  // Se abre en el mes de la fecha ya elegida; si no hay, en el del primer día
  // agendable (normalmente hoy).
  const [month, setMonth] = useState<Month>(() => monthOf(value ?? w.minDate));

  // Si `value` salta a otro mes desde afuera (en el panel, elegir "Desde" en
  // diciembre arrastra el "Hasta"), la vista lo sigue en vez de quedarse en el
  // mes viejo con todo deshabilitado. Ajuste en render, sin efecto ni parpadeo.
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    if (value && monthStart(monthOf(value)) !== monthStart(month)) {
      setMonth(monthOf(value));
    }
  }

  const cells = useMemo(() => monthGrid(month), [month]);

  // Una flecha se apaga cuando el mes destino queda fuera de la ventana. Los
  // primeros de mes son YYYY-MM-01, así que ordenan como strings.
  const current = monthStart(month);
  const canPrev = current > monthStart(monthOf(w.minDate));
  const canNext = current < monthStart(monthOf(w.maxDate));

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <ArrowButton
          label="Mes anterior"
          disabled={!canPrev}
          tone={tone}
          onClick={() => setMonth(addMonths(month, -1))}
        >
          ‹
        </ArrowButton>
        <p
          aria-live="polite"
          className={`font-display text-lg font-semibold uppercase tracking-wide ${
            tone === "dark" ? "text-cream" : "text-ink"
          }`}
        >
          {monthLabel(month)}
        </p>
        <ArrowButton
          label="Mes siguiente"
          disabled={!canNext}
          tone={tone}
          onClick={() => setMonth(addMonths(month, 1))}
        >
          ›
        </ArrowButton>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAY_HEADS.map((d, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`pb-1 text-center text-[11px] uppercase tracking-wider ${
              tone === "dark" ? "text-cream/60" : "text-muted"
            }`}
          >
            {d}
          </span>
        ))}

        {cells.map((d, i) =>
          d == null ? (
            <span key={`gap-${i}`} aria-hidden="true" />
          ) : (
            <DayCell
              key={d}
              dateStr={d}
              config={config}
              win={w}
              allowClosed={allowClosed}
              isToday={d === today}
              active={value === d}
              tone={tone}
              onSelect={onChange}
            />
          ),
        )}
      </div>
    </div>
  );
}

function DayCell({
  dateStr,
  config,
  win,
  allowClosed,
  isToday,
  active,
  tone,
  onSelect,
}: {
  dateStr: string;
  config: SalonConfig;
  win: BookingWindow;
  allowClosed: boolean;
  isToday: boolean;
  active: boolean;
  tone: Tone;
  onSelect: (d: string) => void;
}) {
  const closed = isClosedDay(config, dateStr);
  const inWindow = dateStr >= win.minDate && dateStr <= win.maxDate;
  const selectable = allowClosed ? inWindow : isSelectableDay(config, dateStr, win);
  // El chip viejo escribía "cerrado" bajo el número; en la grilla no hay lugar,
  // así que el motivo viaja en el aria-label para quien use lector de pantalla.
  // Con `allowClosed` el día igual se puede abrir, pero conviene anunciarlo.
  const note = closed ? "cerrado" : "no disponible";

  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={() => onSelect(dateStr)}
      aria-label={
        selectable && !closed
          ? longDateLabel(dateStr)
          : `${longDateLabel(dateStr)}, ${note}`
      }
      aria-current={isToday ? "date" : undefined}
      className={[
        "flex aspect-square items-center justify-center rounded-2xl border font-mono text-base transition-colors",
        !selectable
          ? tone === "dark"
            ? "cursor-not-allowed border-white/10 bg-white/10 text-cream/40"
            : "cursor-not-allowed border-line bg-line/40 text-muted/60"
          : active
            ? "border-brand bg-brand text-white"
            : closed
              ? // Abierto al clic pero el salón no atiende: se distingue del día
                // normal con borde punteado y número apagado.
                "border-dashed border-line bg-line/30 text-muted hover:border-brand hover:text-ink"
              : isToday
                ? "border-brand/50 bg-paper font-semibold text-ink hover:border-brand hover:bg-brand-tint"
                : "border-line bg-paper text-ink hover:border-brand hover:bg-brand-tint",
      ].join(" ")}
    >
      {dateParts(dateStr).day}
    </button>
  );
}

function ArrowButton({
  label,
  disabled,
  tone,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  tone: Tone;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-xl leading-none transition-colors disabled:cursor-not-allowed",
        tone === "dark"
          ? "border-white/25 bg-white/10 text-cream hover:border-gold hover:text-gold disabled:border-white/10 disabled:bg-white/5 disabled:text-cream/35 disabled:hover:border-white/10"
          : "border-line bg-paper text-ink hover:border-brand hover:bg-brand-tint disabled:border-line disabled:bg-line/40 disabled:text-muted/60 disabled:hover:bg-line/40",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
