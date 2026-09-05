"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Appointment } from "@/lib/types";
import type { SalonConfig, SalonService } from "@/lib/salon";
import MonthCalendar from "@/components/MonthCalendar";
import {
  type Slot,
  type BusyRow,
  type BookingWindow,
  type NoSlotsReason,
  getService,
  generateDaySlots,
  shopInstant,
  addDaysStr,
  shopToday,
  formatShopTime,
  shopClock,
  longDateLabel,
  adminBookingWindow,
  agendaWindow,
  isClosedDay,
  minutesToLabel,
  formatDuration,
  noSlotsReason,
  priceLabel,
  hasPrices,
  formatCRC,
  fitsInHours,
  shopMinutes,
  servicesByCategory,
  servicesForBarber,
  weekRange,
  weekRangeLabel,
  dayHours,
  hoursWindow,
  openDaysInRange,
  rangeLengthDays,
  SLOT_STEP_MIN,
} from "@/lib/booking";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isPushSupported,
  isStandalone,
  isIOS,
  subscribeBarber,
  syncSubscription,
  unsubscribeBarber,
} from "@/lib/push";

type ModalState =
  | null
  | { type: "new" }
  | { type: "block" }
  | { type: "reschedule"; appt: Appointment }
  | { type: "editService"; appt: Appointment };

interface WeekStats {
  expected: number;
  realized: number;
  count: number;
  /** Citas de la semana que ya terminaron. Es lo que mide el avance en los
   *  salones sin precios cargados, donde el monto no dice nada. */
  done: number;
  startStr: string;
}

export default function Dashboard({
  config,
  barberId,
  barberName,
  isAdmin,
  barbers,
}: {
  config: SalonConfig;
  barberId: string;
  barberName: string;
  /** La dueña: puede ver y gestionar la agenda de las demás estilistas. */
  isAdmin: boolean;
  /** Estilistas activas del salón, para el selector de agenda. */
  barbers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const tz = config.timezone;
  const supabase = useMemo(() => createClient(), []);
  const [dateStr, setDateStr] = useState<string>(shopToday(tz));
  // Agenda que se está mirando. Sin permisos de admin es siempre la propia.
  const [selectedBarberId, setSelectedBarberId] = useState<string>(barberId);
  const viewing = isAdmin ? selectedBarberId : barberId;
  const viewingSelf = viewing === barberId;
  const viewingName =
    barbers.find((b) => b.id === viewing)?.name ?? barberName;
  const showPicker = isAdmin && barbers.length > 1;
  const [appts, setAppts] = useState<Appointment[]>([]);
  // Calendario del navegador de fechas: plegado por defecto para no empujar la
  // agenda del día hacia abajo en el celular.
  const [calOpen, setCalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [week, setWeek] = useState<WeekStats | null>(null);
  // Notificaciones: reservas recientes + cuántas no ha visto la estilista.
  const [notifs, setNotifs] = useState<Appointment[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  // La suscripción push es del dispositivo de quien inició sesión, no de la
  // agenda que esté mirando: siempre `barberId`, nunca `viewing`.
  const push = usePush(supabase, barberId);

  const load = useCallback(
    async (d: string) => {
      setLoading(true);
      const dayStart = shopInstant(d, 0, tz);
      const dayEnd = shopInstant(addDaysStr(d, 1), 0, tz);
      // El filtro por barbero es explícito: para la admin la RLS ya no alcanza,
      // porque puede leer las citas de todo el salón.
      const { data, error } = await supabase
        .from("appointments")
        .select("*")
        .eq("barber_id", viewing)
        .gte("start_time", dayStart.toISOString())
        .lt("start_time", dayEnd.toISOString())
        .order("start_time");
      if (error) console.error("No se pudo cargar la agenda del día:", error.message);
      setAppts((data ?? []) as Appointment[]);
      setLoading(false);
    },
    [supabase, tz, viewing],
  );

  // Resumen de la semana: esperado = todas las reservas de la semana; realizado
  // = las que ya terminaron (end_time <= ahora). Los montos solo suman los
  // servicios con precio cargado; si el salón no maneja precios, el panel muestra
  // el avance en citas y los montos no se pintan.
  const loadWeek = useCallback(async () => {
    const wr = weekRange(tz);
    const { data, error } = await supabase
      .from("appointments")
      .select("service_slug, end_time")
      .eq("kind", "booking")
      .eq("barber_id", viewing)
      .gte("start_time", wr.start.toISOString())
      .lt("start_time", wr.end.toISOString());
    if (error) console.error("No se pudo cargar el resumen semanal:", error.message);
    const rows = (data ?? []) as {
      service_slug: string | null;
      end_time: string;
    }[];
    const now = Date.now();
    let expected = 0;
    let realized = 0;
    let count = 0;
    let done = 0;
    for (const r of rows) {
      if (!r.service_slug) continue;
      const price = getService(config, r.service_slug)?.priceCRC ?? 0;
      expected += price;
      count += 1;
      if (new Date(r.end_time).getTime() <= now) {
        realized += price;
        done += 1;
      }
    }
    setWeek({ expected, realized, count, done, startStr: wr.startStr });
  }, [supabase, config, tz, viewing]);

  // Reservas recientes (hechas por clientes), más nuevas primero. Se cargan al
  // montar sin tocar el contador de no-vistas — solo los inserts en vivo lo suben.
  const loadNotifs = useCallback(async () => {
    const { data, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("kind", "booking")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) console.error("No se pudieron cargar las notificaciones:", error.message);
    setNotifs((data ?? []) as Appointment[]);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadNotifs();
  }, [loadNotifs]);

  useEffect(() => {
    // Carga la agenda del día desde Supabase; el setState ocurre tras resolver
    // el async, que es el patrón esperado de fetch-en-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(dateStr);
  }, [dateStr, load]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadWeek();
  }, [loadWeek]);

  // Realtime: refresca en vivo cuando cambian las citas del salón (p. ej. un
  // cliente reserva). Se escucha el salón entero para que la campana de la dueña
  // suene con las reservas de cualquier estilista; la RLS igual recorta el stream
  // — quien no es admin solo recibe sus propias filas, así que el filtro por
  // salón le da exactamente lo mismo que el filtro por barbero.
  useEffect(() => {
    const channel = supabase
      .channel(`appointments-${config.id}-${barberId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "appointments",
          filter: `salon_id=eq.${config.id}`,
        },
        (payload) => {
          load(dateStr);
          loadWeek();
          // Un cliente acaba de reservar: mostrarlo en notificaciones y encender
          // el punto rojo hasta que abra el panel.
          if (payload.eventType === "INSERT") {
            const row = payload.new as Appointment;
            if (row.kind === "booking") {
              setNotifs((prev) =>
                [row, ...prev.filter((n) => n.id !== row.id)].slice(0, 30),
              );
              setUnseen((u) => u + 1);
            }
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, config.id, barberId, dateStr, load, loadWeek]);

  function toggleNotif() {
    setNotifOpen((open) => {
      if (!open) setUnseen(0);
      return !open;
    });
  }

  async function removeAppt(id: string) {
    if (!confirm("¿Eliminar este espacio de tu agenda?")) return;
    const { error } = await supabase.from("appointments").delete().eq("id", id);
    if (error) {
      console.error("No se pudo eliminar la cita:", error.message);
      alert("No se pudo eliminar. Intentá de nuevo.");
      return;
    }
    load(dateStr);
    loadWeek();
  }

  async function logout() {
    await supabase.auth.signOut();
    router.push("/barbero/login");
    router.refresh();
  }

  const isToday = dateStr === shopToday(tz);
  // Hasta dónde llega el navegador de la agenda. Es la misma ventana para el
  // calendario y para las flechas: si la flecha pudiera pasarse, el calendario
  // abriría en un mes con todos los días apagados.
  const agendaWin = useMemo(() => agendaWindow(tz), [tz]);
  const canGoBack = dateStr > agendaWin.minDate;
  const canGoNext = dateStr < agendaWin.maxDate;

  return (
    <div className="flex-1">
      {/* `pt-safe-top`: con la app instalada en iPhone el contenido arranca
          debajo del reloj y el notch. */}
      <header className="border-b border-line bg-paper pt-safe-top">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-4 py-3 sm:gap-3 sm:px-5">
          {/* `min-w-0` en toda la cadena: el nombre del salón lleva mucho
              interletrado y, sin recortar, empujaba los botones fuera de la
              pantalla en celular. */}
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-[#0b0b0b]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo.png"
                alt={config.name}
                className="h-full w-full object-contain"
              />
            </span>
            <div className="min-w-0">
              <p className="truncate font-display text-[10px] uppercase tracking-[0.2em] text-brand sm:text-xs sm:tracking-[0.3em]">
                {config.name}
              </p>
              <p className="truncate font-display text-base font-semibold uppercase tracking-wide text-ink sm:text-lg">
                {viewingName}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <ShareButton shopName={config.name} />
            <NotifBell
              notifs={notifs}
              unseen={unseen}
              open={notifOpen}
              onToggle={toggleNotif}
              onClose={() => setNotifOpen(false)}
              config={config}
              push={push}
            />
            <button
              onClick={logout}
              className="rounded-full border border-line px-3 py-2 text-xs font-medium text-ink transition-colors hover:border-brand hover:text-brand sm:px-4 sm:text-sm"
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 pb-[calc(5rem_+_env(safe-area-inset-bottom))] sm:px-5">
        {/* Banner de push: solo aparece si falta instalar la app, activar los
            avisos, o si no se pudo confirmar la suscripción contra la base. */}
        <PushSetup push={push} />

        {/* Buscador de citas futuras — solo de la agenda que se está mirando.
            `key={viewing}`: al cambiar de estilista se reinicia, para no dejar
            en pantalla resultados de otra agenda. */}
        <AppointmentSearch
          key={viewing}
          supabase={supabase}
          config={config}
          barberId={viewing}
          onPick={setDateStr}
        />

        {/* Selector de agenda (solo la dueña, y solo si hay más de una) */}
        {showPicker && (
          <BarberPicker
            barbers={barbers}
            selected={viewing}
            onSelect={setSelectedBarberId}
          />
        )}

        {/* Resumen de la semana — de la estilista seleccionada */}
        {week && <WeeklyPanel week={week} config={config} />}

        {/* Navegador de fechas. Las flechas mueven un día; tocar la fecha abre
            el calendario del mes para saltar lejos sin cientos de clics (hay
            clientas que agendan con ocho meses de anticipación). */}
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => setDateStr((d) => addDaysStr(d, -1))}
              disabled={!canGoBack}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line text-ink transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:border-line disabled:text-muted/60 disabled:hover:border-line disabled:hover:text-muted/60"
              aria-label="Día anterior"
            >
              ‹
            </button>
            {/* "Miércoles 3 de septiembre" no cabe entre las dos flechas en un
                teléfono angosto: `min-w-0` lo deja partir en dos líneas. */}
            <div className="min-w-0 text-center">
              <button
                onClick={() => setCalOpen((v) => !v)}
                aria-expanded={calOpen}
                aria-label={`${longDateLabel(dateStr)}. Elegir otra fecha en el calendario`}
                className="font-display text-lg font-semibold uppercase tracking-tight text-ink transition-colors hover:text-brand sm:text-xl"
              >
                {longDateLabel(dateStr)}{" "}
                <span aria-hidden="true" className="text-sm text-muted">
                  {calOpen ? "▴" : "▾"}
                </span>
              </button>
              {!isToday && (
                <button
                  onClick={() => setDateStr(shopToday(tz))}
                  className="block w-full text-xs font-medium text-brand hover:text-brand-deep"
                >
                  Ir a hoy
                </button>
              )}
              {isToday && (
                <p className="text-xs uppercase tracking-wider text-muted">Hoy</p>
              )}
            </div>
            <button
              onClick={() => setDateStr((d) => addDaysStr(d, 1))}
              disabled={!canGoNext}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line text-ink transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:border-line disabled:text-muted/60 disabled:hover:border-line disabled:hover:text-muted/60"
              aria-label="Día siguiente"
            >
              ›
            </button>
          </div>

          {calOpen && (
            <div className="mt-3 rounded-2xl border border-line bg-paper p-3">
              {/* `allowClosed`: en la agenda sí hace falta poder abrir un día
                  cerrado — ahí es donde se ven los bloqueos de todo el día. */}
              <MonthCalendar
                config={config}
                value={dateStr}
                onChange={(d) => {
                  setDateStr(d);
                  setCalOpen(false);
                }}
                window={agendaWin}
                allowClosed
              />
            </div>
          )}
        </div>

        {/* Acciones */}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            onClick={() => setModal({ type: "new" })}
            className="inline-flex items-center justify-center rounded-full bg-brand px-4 py-3 font-display text-sm font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep"
          >
            + Nueva cita
          </button>
          <button
            onClick={() => setModal({ type: "block" })}
            className="inline-flex items-center justify-center rounded-full border border-line px-4 py-3 font-display text-sm font-semibold uppercase tracking-wide text-ink transition-colors hover:border-brand hover:text-brand"
          >
            Bloquear horario
          </button>
        </div>

        {/* Agenda */}
        <div className="mt-6">
          {loading ? (
            <p className="py-12 text-center text-muted">Cargando agenda…</p>
          ) : appts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line px-5 py-12 text-center">
              <p className="text-ink">
                {viewingSelf
                  ? "No tenés citas este día."
                  : `${viewingName} no tiene citas este día.`}
              </p>
              <p className="mt-1 text-sm text-muted">
                {viewingSelf
                  ? "Los clientes pueden reservar con vos desde la web."
                  : "Los clientes pueden reservar desde la web."}
              </p>
            </div>
          ) : (
            <ul className="grid gap-3">
              {appts.map((a) => (
                <AgendaRow
                  key={a.id}
                  appt={a}
                  config={config}
                  onDelete={() => removeAppt(a.id)}
                  onReschedule={() => setModal({ type: "reschedule", appt: a })}
                  onEditService={() => setModal({ type: "editService", appt: a })}
                />
              ))}
            </ul>
          )}
        </div>

        <p className="mt-8 text-center text-xs text-muted">
          {showPicker
            ? "Agenda privada del salón. Solo vos podés verla y administrarla."
            : "Esta es tu agenda privada. Nadie más puede verla."}
        </p>
      </div>

      {modal?.type === "new" && (
        <NewAppointmentModal
          supabase={supabase}
          config={config}
          barberId={viewing}
          barberName={viewingName}
          isAdmin={isAdmin}
          defaultDate={dateStr}
          onClose={() => setModal(null)}
          onDone={(d) => {
            setModal(null);
            setDateStr(d);
            load(d);
          }}
        />
      )}
      {modal?.type === "block" && (
        <BlockModal
          supabase={supabase}
          config={config}
          barberId={viewing}
          defaultDate={dateStr}
          onClose={() => setModal(null)}
          onDone={(d) => {
            setModal(null);
            setDateStr(d);
            load(d);
          }}
        />
      )}
      {modal?.type === "reschedule" && (
        <RescheduleModal
          supabase={supabase}
          config={config}
          appt={modal.appt}
          barberName={viewingName}
          onClose={() => setModal(null)}
          onDone={(d) => {
            setModal(null);
            setDateStr(d);
            load(d);
          }}
        />
      )}
      {modal?.type === "editService" && (
        <EditServiceModal
          supabase={supabase}
          config={config}
          appt={modal.appt}
          isAdmin={isAdmin}
          onClose={() => setModal(null)}
          onDone={(d) => {
            setModal(null);
            setDateStr(d);
            load(d);
          }}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------- push notifications */

type PushStatus =
  | "loading"
  | "unsupported"
  | "need-install"
  | "off"
  | "on"
  | "error";

type PushState = {
  status: PushStatus;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
};

// El estado del push vive acá arriba, y no dentro del banner, porque lo consumen
// dos lugares: el banner (que solo aparece cuando hay algo que hacer) y el
// toggle dentro de la campanita (que está siempre disponible).
function usePush(supabase: SupabaseClient, barberId: string): PushState {
  const [status, setStatus] = useState<PushStatus>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // iOS solo expone la API de push cuando la web está instalada en la
      // pantalla de inicio; antes de eso hay que guiar a instalarla.
      if (!isPushSupported()) {
        const next = isIOS() && !isStandalone() ? "need-install" : "unsupported";
        if (!cancelled) setStatus(next);
        return;
      }
      // El permiso del navegador no alcanza: hay que confirmar contra la base y
      // reponer la fila si falta. Ver `syncSubscription` en `src/lib/push.ts`.
      const next = await syncSubscription(supabase, barberId);
      if (!cancelled) setStatus(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, barberId]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await subscribeBarber(supabase, barberId);
      setStatus("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo activar.");
    } finally {
      setBusy(false);
    }
  }, [supabase, barberId]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await unsubscribeBarber(supabase);
      setStatus("off");
    } catch {
      setError("No se pudo desactivar. Intentá de nuevo.");
    } finally {
      setBusy(false);
    }
  }, [supabase]);

  return { status, busy, error, enable, disable };
}

// Banner que instala la app (iOS) y activa las notificaciones push del sistema
// para que la estilista reciba un aviso por cada reserva aunque tenga la app
// cerrada. Se auto-oculta cuando ya está todo activado; para apagarlas está el
// toggle de la campanita.
function PushSetup({ push }: { push: PushState }) {
  const { status, busy, error, enable } = push;

  // Con los avisos andando no se muestra nada: el panel queda limpio y el banner
  // solo aparece cuando hay algo que hacer. Esto es seguro porque
  // `syncSubscription` verifica contra la base, así que "sin banner" ya no puede
  // significar "roto en silencio" como cuando se miraba Notification.permission.
  if (status === "loading" || status === "unsupported" || status === "on") {
    return null;
  }

  // No se pudo confirmar contra la base. Se avisa en vez de callar: el modo de
  // fallo que importa es el silencioso, donde el panel dice "activadas" y no
  // llega nada.
  if (status === "error") {
    return (
      <div className="mt-4 rounded-2xl border border-red-300 bg-red-50 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-display text-sm font-semibold uppercase tracking-wide text-red-700">
              No pudimos confirmar tus avisos
            </p>
            <p className="mt-1 text-sm text-ink">
              Puede que no te lleguen las notificaciones de reservas nuevas.
              Mirá la campanita de arriba para no perderte ninguna cita.
            </p>
          </div>
          <button
            onClick={enable}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-full bg-brand px-4 py-2.5 font-display text-sm font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep disabled:opacity-60"
          >
            {busy ? "Reintentando…" : "Reintentar"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  if (status === "need-install") {
    return (
      <div className="mt-4 rounded-2xl border border-brand/30 bg-brand/5 px-4 py-3">
        <p className="font-display text-sm font-semibold uppercase tracking-wide text-brand">
          Recibí un aviso por cada reserva
        </p>
        <p className="mt-1 text-sm text-ink">
          En iPhone/iPad, primero instalá la app: tocá el botón{" "}
          <span aria-hidden>⎋</span> <strong>Compartir</strong> y luego{" "}
          <strong>“Agregar a inicio”</strong>. Abrí la app desde el ícono y volvé
          acá para activar las notificaciones.
        </p>
      </div>
    );
  }

  // status === "off"
  return (
    <div className="mt-4 rounded-2xl border border-brand/30 bg-brand/5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-sm font-semibold uppercase tracking-wide text-brand">
            Activá los avisos de reservas
          </p>
          <p className="mt-1 text-sm text-ink">
            Ahora mismo no estás recibiendo avisos.
          </p>
        </div>
        <button
          onClick={enable}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-full bg-brand px-4 py-2.5 font-display text-sm font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep disabled:opacity-60"
        >
          {busy ? "Activando…" : "Activar notificaciones"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// Interruptor de los avisos al teléfono. Vive dentro del panel de la campanita
// porque es donde uno busca un ajuste de notificaciones, y así la cabecera no
// queda con dos campanas seguidas queriendo decir cosas distintas.
function PushToggleRow({ push }: { push: PushState }) {
  const { status, busy, enable, disable } = push;
  // Mientras carga, o si el equipo no soporta push, no hay nada que ofrecer. El
  // caso "need-install" (iPhone sin instalar) lo cubre el banner con el paso a
  // paso; un toggle suelto ahí solo confundiría.
  if (status !== "on" && status !== "off" && status !== "error") return null;

  const on = status === "on";
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-ink">Avisos al teléfono</p>
        <p className="text-xs text-muted">
          {on
            ? "Activados en este dispositivo"
            : status === "error"
              ? "No se pudo confirmar"
              : "Desactivados"}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Avisos al teléfono"
        onClick={on ? disable : enable}
        disabled={busy}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          on ? "bg-brand" : "bg-line"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            on ? "left-[1.375rem]" : "left-0.5"
          }`}
          aria-hidden
        />
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- compartir */

// Botón que abre la hoja de compartir nativa del teléfono (Web Share API) con el
// enlace de reservas, para pasarlo a las clientas por WhatsApp, etc. En equipos
// sin `navigator.share` (escritorio) copia el enlace al portapapeles.
function ShareButton({ shopName }: { shopName: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = window.location.origin;
    const shareData = {
      title: `${shopName} — Reservá tu cita`,
      text: `Reservá tu cita en ${shopName} ✨`,
      url,
    };
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // Se cerró la hoja sin compartir (AbortError) u otro error: ignorar.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin permiso de portapapeles: no hay más que hacer de forma segura.
    }
  }

  return (
    <div className="relative">
      <button
        onClick={share}
        aria-label="Compartir enlace de reservas"
        className="grid h-10 w-10 place-items-center rounded-full border border-line text-ink transition-colors hover:border-brand hover:text-brand"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.59 13.51l6.83 3.98" />
          <path d="M15.41 6.51l-6.82 3.98" />
        </svg>
      </button>
      {copied && (
        <span className="absolute right-0 top-12 z-50 whitespace-nowrap rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper shadow-lg">
          ¡Enlace copiado!
        </span>
      )}
    </div>
  );
}

/* --------------------------------------------------------- notifications */

function NotifBell({
  notifs,
  unseen,
  open,
  onToggle,
  onClose,
  config,
  push,
}: {
  notifs: Appointment[];
  unseen: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  config: SalonConfig;
  push: PushState;
}) {
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        aria-label="Notificaciones"
        className="relative grid h-10 w-10 place-items-center rounded-full border border-line text-ink transition-colors hover:border-brand hover:text-brand"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unseen > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-red-600 px-1 text-[11px] font-bold leading-none text-white ring-2 ring-paper">
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Fondo para cerrar al tocar fuera */}
          <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
          {/* En celular: fijo al viewport con márgenes (inset-x-4) para que no se
              corte a la izquierda. El `top` suma la zona segura del notch, si no
              el panel queda montado sobre la cabecera en la app instalada.
              En sm+: dropdown anclado bajo la campana. */}
          <div className="fixed inset-x-4 top-[calc(4rem_+_env(safe-area-inset-top))] z-50 overflow-hidden rounded-2xl border border-line bg-paper shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-80">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <p className="font-display text-sm font-semibold uppercase tracking-wide text-ink">
                Reservas
              </p>
              <button
                onClick={onClose}
                aria-label="Cerrar"
                className="grid h-7 w-7 place-items-center rounded-full text-muted transition-colors hover:bg-line hover:text-brand"
              >
                ✕
              </button>
            </div>
            {notifs.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">
                Aún no hay reservas.
              </p>
            ) : (
              <ul className="max-h-80 overflow-y-auto">
                {notifs.map((n) => {
                  const svc = n.service_slug
                    ? getService(config, n.service_slug)
                    : null;
                  return (
                    <li
                      key={n.id}
                      className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0"
                    >
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand"
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-display text-sm font-semibold uppercase tracking-wide text-ink">
                          {n.client_name ?? "Cliente"}
                        </p>
                        <p className="text-xs text-muted">
                          {longDateLabel(
                            new Intl.DateTimeFormat("en-CA", {
                              timeZone: config.timezone,
                            }).format(new Date(n.start_time)),
                          )}{" "}
                          · {formatShopTime(n.start_time, config.timezone)}
                        </p>
                        {svc && (
                          <p className="text-xs text-muted">{svc.label}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <PushToggleRow push={push} />
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------ buscador de citas */

/** Busca por nombre o teléfono entre las citas FUTURAS de la agenda que se está
 *  mirando — nunca de todo el salón: el filtro por `barberId` es explícito
 *  porque la dueña sí puede leer las filas de las demás. Tocar un resultado
 *  lleva la agenda del día a esa fecha.
 *
 *  El componente se monta con `key={viewing}`, así que cambiar de agenda lo
 *  reinicia y no quedan resultados de otra estilista en pantalla.
 */
function AppointmentSearch({
  supabase,
  config,
  barberId,
  onPick,
}: {
  supabase: SupabaseClient;
  config: SalonConfig;
  barberId: string;
  onPick: (dateStr: string) => void;
}) {
  const [q, setQ] = useState("");
  // Se guarda junto al término que lo produjo: así, mientras se escribe algo
  // nuevo, no se muestran los resultados de la búsqueda anterior.
  const [res, setRes] = useState<{ term: string; rows: Appointment[] } | null>(
    null,
  );

  // PostgREST separa los filtros de `.or()` con comas y paréntesis, y `%`/`_`
  // son comodines de `ilike`: se limpian para que la búsqueda sea literal.
  const term = q.trim().replace(/[,()%_\\]/g, " ").trim();
  const searching = term.length >= 2;
  const hits = res && res.term === term ? res.rows : null;

  useEffect(() => {
    if (!searching) return;
    let cancelled = false;
    // Espera a que deje de escribir; si no, sale una consulta por tecla.
    const timer = setTimeout(async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select("*")
        .eq("kind", "booking")
        .eq("barber_id", barberId)
        .gte("start_time", new Date().toISOString())
        .or(`client_name.ilike.%${term}%,client_phone.ilike.%${term}%`)
        .order("start_time")
        .limit(20);
      if (cancelled) return;
      if (error) console.error("No se pudo buscar la cita:", error.message);
      setRes({ term, rows: (data ?? []) as Appointment[] });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [supabase, barberId, term, searching]);

  // Día calendario de la cita en la zona del salón (YYYY-MM-DD).
  const dayOf = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(
      new Date(iso),
    );

  return (
    <div className="mt-4 rounded-2xl border border-line bg-paper px-5 py-4">
      {/* Mismo encabezado que "Esta semana": las tres cajas del panel se leen
          como una sola familia. */}
      <p className="font-display text-sm font-semibold uppercase tracking-wide text-ink">
        Buscar cita
      </p>

      <div className="mt-3 flex items-center gap-3">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nombre o teléfono"
          aria-label="Buscar una cita futura por nombre o teléfono"
          className="w-full min-w-0 rounded-xl border border-line bg-paper px-4 py-2.5 text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-brand"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ("")}
            className="shrink-0 text-xs font-medium text-muted underline underline-offset-2 transition-colors hover:text-ink"
          >
            Limpiar
          </button>
        )}
      </div>

      {q.trim() && !searching && (
        <p className="mt-3 text-sm text-muted">Escribí al menos dos letras.</p>
      )}

      {searching && hits === null && (
        <p className="mt-3 text-sm text-muted">Buscando…</p>
      )}

      {hits !== null && hits.length === 0 && (
        <p className="mt-3 text-sm text-muted">
          No hay citas futuras que coincidan.
        </p>
      )}

      {hits !== null && hits.length > 0 && (
        // `minmax(0,1fr)` en la columna y `min-w-0` en el <li>: los renglones
        // del resultado usan `truncate` (white-space: nowrap), y eso hace que su
        // ancho mínimo sea la línea entera. Sin acotar la pista, el grid crece
        // con el texto y el renglón se sale de la tarjeta (se veía en el
        // iPhone). La agenda no tiene el problema porque usa `break-words`.
        <ul className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2">
          {hits.map((a) => {
            const day = dayOf(a.start_time);
            const svc = a.service_slug
              ? getService(config, a.service_slug)
              : null;
            return (
              <li key={a.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onPick(day)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition-colors hover:border-brand hover:bg-brand-tint"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-display text-sm font-semibold uppercase tracking-wide text-ink">
                      {a.client_name ?? "Cita"}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {longDateLabel(day)} ·{" "}
                      {formatShopTime(a.start_time, config.timezone)}
                      {svc && ` · ${svc.label}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-brand">
                    Ver día
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------- barber picker */

/** Selector de agenda para la dueña del salón. Todo lo que hay debajo —agenda
 *  del día, panel semanal, alta de citas y bloqueos— sigue a esta selección. */
function BarberPicker({
  barbers,
  selected,
  onSelect,
}: {
  barbers: { id: string; name: string }[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    // Sin `<fieldset>/<legend>`: el rótulo partía el borde redondeado del card
    // y quedaba corrido respecto de los chips. Un `role="radiogroup"` con
    // `aria-labelledby` agrupa igual para el lector de pantalla, sin ese corte.
    <div
      role="radiogroup"
      aria-labelledby="agenda-de"
      className="mt-6 rounded-2xl border border-line bg-paper px-5 py-4"
    >
      <p
        id="agenda-de"
        className="font-display text-sm font-semibold uppercase tracking-wide text-ink"
      >
        Agenda de
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {barbers.map((b) => {
          const active = b.id === selected;
          return (
            <label
              key={b.id}
              className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-brand bg-brand text-white"
                  : "border-line text-ink hover:border-brand hover:text-brand"
              }`}
            >
              <input
                type="radio"
                name="agenda-barbero"
                className="sr-only"
                checked={active}
                onChange={() => onSelect(b.id)}
              />
              <span
                aria-hidden
                className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${
                  active ? "border-white" : "border-muted"
                }`}
              >
                {active && (
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                )}
              </span>
              {b.name}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- weekly panel */

// Con precios cargados mide plata: cuánto del dinero esperado ya se realizó.
// Sin precios mostraría "₡0 de ₡0", así que mide citas: cuántas de la semana ya
// pasaron. El día que se carguen los montos, el panel vuelve solo — sin redeploy.
function WeeklyPanel({
  week,
  config,
}: {
  week: WeekStats;
  config: SalonConfig;
}) {
  const money = hasPrices(config);
  const base = money ? week.expected : week.count;
  const reached = money ? week.realized : week.done;
  const pct = base > 0 ? Math.round((reached / base) * 100) : 0;
  return (
    <div className="relative mt-6 overflow-hidden rounded-2xl border border-line bg-paper">
      <div className="px-5 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-display text-sm font-semibold uppercase tracking-wide text-ink">
            Esta semana
          </p>
          <p className="text-xs text-muted">{weekRangeLabel(week.startStr)}</p>
        </div>

        {/* Los montos en colones son largos: en celular la fila se parte en dos
            en vez de encimarse el porcentaje con el total. */}
        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="font-display text-3xl font-bold leading-none text-brand sm:text-4xl">
              {pct}%
            </p>
            <p className="mt-1 text-xs text-muted">
              {money
                ? "del dinero esperado ya realizado"
                : "de las citas de la semana ya atendidas"}
            </p>
          </div>
          <div className="min-w-0 text-right">
            <p className="font-mono text-base font-medium text-ink sm:text-lg">
              {money ? formatCRC(week.realized) : week.done}
            </p>
            <p className="text-xs text-muted">
              {money && `de ${formatCRC(week.expected)} · `}
              {week.count} {week.count === 1 ? "cita" : "citas"}
            </p>
          </div>
        </div>

        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-brand transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>

        <p className="mt-2 text-[11px] text-muted/80">
          El total considera solo servicios con precio fijo (los “Por cotizar” no
          suman).
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- agenda */

function AgendaRow({
  appt,
  config,
  onDelete,
  onReschedule,
  onEditService,
}: {
  appt: Appointment;
  config: SalonConfig;
  onDelete: () => void;
  onReschedule: () => void;
  onEditService: () => void;
}) {
  const isBlock = appt.kind === "block";
  const svc = appt.service_slug ? getService(config, appt.service_slug) : null;
  // En la columna de la hora el meridiano va debajo: así "10:00 a.m." no le
  // roba ancho al nombre de la clienta en celular.
  const clock = shopClock(appt.start_time, config.timezone);

  return (
    <li className="relative overflow-hidden rounded-2xl border border-line bg-paper">
      <div
        className={`absolute inset-y-0 left-0 w-1.5 ${isBlock ? "bg-gold" : "bg-brand"}`}
        aria-hidden
      />
      <div className="flex items-start justify-between gap-3 py-4 pl-4 pr-3 sm:pl-5 sm:pr-4">
        {/* `min-w-0` en la cadena: un nombre de clienta largo desbordaba la
            tarjeta y se metía debajo de los botones de la derecha. */}
        <div className="flex min-w-0 gap-3 sm:gap-4">
          <div className="shrink-0 text-center">
            <p className="font-mono text-lg font-medium leading-none text-ink">
              {clock.time}
            </p>
            <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
              {clock.meridiem}
            </p>
            {isBlock && (
              <p className="mt-1 font-mono text-xs text-muted">
                {formatShopTime(appt.end_time, config.timezone)}
              </p>
            )}
          </div>
          <div className="min-w-0 break-words">
            {isBlock ? (
              <>
                <p className="font-display text-base font-semibold uppercase tracking-wide text-ink">
                  Bloqueado
                </p>
                <p className="text-sm text-muted">
                  Tiempo personal · no reservable
                </p>
              </>
            ) : (
              <>
                <p className="font-display text-base font-semibold uppercase tracking-wide text-ink">
                  {appt.client_name ?? "Cita"}
                </p>
                <p className="text-sm text-muted">
                  {svc?.label ?? "Servicio"}
                  {svc && priceLabel(svc) && ` · ${priceLabel(svc)}`}
                </p>
                {appt.client_phone && (
                  <a
                    href={`tel:${appt.client_phone}`}
                    className="mt-0.5 inline-block font-mono text-xs text-brand hover:text-brand-deep"
                  >
                    {appt.client_phone}
                  </a>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {!isBlock && (
            <>
              <button
                onClick={onEditService}
                className="text-xs font-medium text-brand hover:text-brand-deep"
              >
                Servicio
              </button>
              <button
                onClick={onReschedule}
                className="text-xs font-medium text-brand hover:text-brand-deep"
              >
                Reagendar
              </button>
            </>
          )}
          <button
            onClick={onDelete}
            className="text-xs font-medium text-muted hover:text-brand-deep"
          >
            Eliminar
          </button>
        </div>
      </div>
    </li>
  );
}

/* --------------------------------------------------------------- shared */

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-5"
      onClick={onClose}
    >
      <div
        // `dvh` y no `vh`: en el celular `vh` cuenta la barra del navegador
        // como si no estuviera y la hoja se pasaba por debajo del borde
        // visible. El relleno de abajo esquiva la barra de gestos.
        className="max-h-[92dvh] w-full min-w-0 max-w-md overflow-y-auto rounded-t-3xl border border-line bg-paper p-5 pb-[calc(1.25rem_+_env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold uppercase tracking-tight text-ink">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-line hover:text-brand"
          >
            ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * Fecha con la que arranca un modal: nunca en el pasado y nunca un día cerrado.
 *
 * Las dos cosas se alcanzan desde la agenda —se puede estar mirando un día que
 * ya pasó, o parada en un domingo, que es justo lo que habilita `allowClosed`—
 * y en ninguna se agenda: sin esto el modal abre en un mes con todo apagado, o
 * en un día que solo sabe decir "el salón no abre".
 *
 * El tope de vueltas es una red: un salón con la semana entera cerrada dejaría
 * el bucle sin salida.
 */
function seedDate(config: SalonConfig, dateStr: string): string {
  const today = shopToday(config.timezone);
  let d = dateStr < today ? today : dateStr;
  for (let i = 0; i < 7 && isClosedDay(config, d); i++) d = addDaysStr(d, 1);
  return d;
}

/**
 * Selector de servicio, acotado a lo que ESA estilista realiza — la misma regla
 * que ve el cliente y que aplica la base. `notFitting` deshabilita los que a esa
 * hora no caben (chocan con el almuerzo o se pasan del cierre), para no ofrecer
 * un cambio que el servidor va a rechazar.
 *
 * `admin` suma los servicios internos (los tratamientos largos que se coordinan
 * por teléfono). Solo la administradora los ve, y solo a ella se los acepta
 * `book_appointment`.
 */
function ServiceSelect({
  config,
  barberId,
  admin,
  value,
  onChange,
  notFitting,
}: {
  config: SalonConfig;
  barberId: string;
  admin: boolean;
  value: string;
  onChange: (slug: string) => void;
  notFitting?: (s: SalonService) => boolean;
}) {
  const barber = config.barbers.find((b) => b.id === barberId) ?? null;
  const svc = getService(config, value);
  const price = svc ? priceLabel(svc) : null;
  // El servicio que la cita YA tiene puede no estar en la lista visible: uno
  // interno abierto por una estilista que no es la admin, o uno dado de baja del
  // catálogo. Se agrega igual, porque un <select> cuyo `value` no existe entre
  // sus opciones se planta solo en la primera y cambiaría la cita sin que nadie
  // lo pidiera.
  const visible = servicesForBarber(config, barber, { admin });
  const orphan =
    svc && !visible.some((s) => s.slug === svc.slug) ? svc : null;
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink">Servicio</p>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-ink outline-none focus:border-brand"
      >
        {orphan && (
          <option value={orphan.slug}>{orphan.label} — el de esta cita</option>
        )}
        {config.categories.map((cat) => {
          const items = servicesByCategory(config, cat.slug, barber, { admin });
          if (items.length === 0) return null;
          return (
            <optgroup key={cat.slug} label={cat.label}>
              {items.map((s) => {
                const p = priceLabel(s);
                const blocked = notFitting?.(s) ?? false;
                return (
                  <option key={s.slug} value={s.slug} disabled={blocked}>
                    {s.label}
                    {p && ` — ${p}`}
                    {blocked && " (no cabe a esa hora)"}
                  </option>
                );
              })}
            </optgroup>
          );
        })}
      </select>
      {price && <p className="mt-1.5 font-mono text-xs text-muted">{price}</p>}
    </div>
  );
}

/** Horario del día en palabras ("de 8:00 a.m. a 5:00 p.m., con descanso de
 *  12:00 p.m. a 1:00 p.m."). El descanso se omite en los servicios que pueden
 *  pasarle por encima: mencionarlo ahí solo confundiría. */
function hoursSentence(
  config: SalonConfig,
  dateStr: string,
  service: SalonService | null,
): string {
  const h = dayHours(config, dateStr);
  if (!h) return "";
  const base = `de ${minutesToLabel(h.openMin)} a ${minutesToLabel(h.closeMin)}`;
  if (h.breakStartMin == null || h.breakEndMin == null || service?.ignoresBreak)
    return base;
  return `${base}, con descanso de ${minutesToLabel(h.breakStartMin)} a ${minutesToLabel(h.breakEndMin)}`;
}

/** Aviso dorado: no es un error de la app, es la agenda diciendo que no. */
function SlotNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gold/50 bg-gold-tint px-4 py-3 text-sm leading-relaxed text-gold-deep">
      {children}
    </div>
  );
}

/**
 * Por qué el día entero se quedó sin espacios. "Sin horarios disponibles"
 * alcanzaba con cortes de 30 min; con un servicio de 4 h la administradora tiene
 * a la clienta al teléfono y necesita saber si mover la otra cita o proponer otro
 * día.
 */
function NoSlotsNotice({
  config,
  dateStr,
  service,
  barberName,
  reason,
}: {
  config: SalonConfig;
  dateStr: string;
  service: SalonService | null;
  barberName: string;
  reason: NoSlotsReason;
}) {
  const dayLabel = longDateLabel(dateStr);
  const largo = service ? formatDuration(service.durationMin) : "";

  if (reason === "closed")
    return <SlotNotice>El salón no abre el {dayLabel}.</SlotNotice>;

  if (reason === "past")
    return (
      <SlotNotice>
        Ya pasaron todas las horas de inicio del {dayLabel}.
      </SlotNotice>
    );

  if (reason === "blocked")
    return (
      <SlotNotice>
        <strong className="font-semibold">{barberName}</strong> tiene bloqueado el{" "}
        {dayLabel}. Quitá el bloqueo o elegí otro día.
      </SlotNotice>
    );

  if (reason === "does-not-fit")
    return (
      <SlotNotice>
        <strong className="font-semibold">{service?.label}</strong> ocupa {largo}{" "}
        seguidas y no entra en la jornada del {dayLabel}: se atiende{" "}
        {hoursSentence(config, dateStr, service)}. Elegí otro día.
      </SlotNotice>
    );

  return (
    <SlotNotice>
      <strong className="font-semibold">
        No se puede agendar el {dayLabel}:
      </strong>{" "}
      ya hay citas en la agenda de {barberName} y {service?.label} necesita{" "}
      {largo} seguidas, así que no queda ningún bloque libre de ese largo.
      Reagendá la otra cita o elegí otro día.
    </SlotNotice>
  );
}

/** Por qué NO se puede tomar UNA hora concreta de la rejilla. */
function SlotBlockedNotice({
  config,
  slot,
  service,
  barberName,
}: {
  config: SalonConfig;
  slot: Slot;
  service: SalonService | null;
  barberName: string;
}) {
  const tz = config.timezone;
  const span = `de ${formatShopTime(slot.start, tz)} a ${formatShopTime(slot.end, tz)}`;

  if (slot.reason === "past")
    return <SlotNotice>Las {slot.label} de hoy ya pasaron.</SlotNotice>;

  if (slot.reason === "blocked")
    return (
      <SlotNotice>{barberName} tiene ese rato bloqueado en la agenda.</SlotNotice>
    );

  return (
    <SlotNotice>
      <strong className="font-semibold">
        A las {slot.label} no se puede agendar:
      </strong>{" "}
      {service?.label ?? "el servicio"} ocuparía {span} y ya hay una clienta en la
      agenda de {barberName} durante ese lapso.
    </SlotNotice>
  );
}

/**
 * Rejilla de horas de inicio. Los espacios que no se pueden tomar siguen
 * tachados, pero ahora responden al toque: con un servicio de 4 h, "las 10:00 no
 * se puede porque a las 11:00 entra otra clienta" es justo lo que la
 * administradora tiene que contestarle a quien está llamando.
 */
function SlotButtons({
  config,
  dateStr,
  service,
  barberName,
  slots,
  selectedMin,
  onSelect,
}: {
  config: SalonConfig;
  dateStr: string;
  service: SalonService | null;
  barberName: string;
  slots: Slot[];
  selectedMin: number | null;
  onSelect: (s: Slot) => void;
}) {
  // El motivo se guarda junto con el día y el servicio para los que se abrió: si
  // cambia cualquiera de los dos, la explicación vieja deja de aplicar y
  // desaparece sola, sin un efecto que la limpie.
  const [why, setWhy] = useState<{ key: string; slot: Slot } | null>(null);
  const key = `${dateStr}|${service?.slug ?? ""}`;
  const shown = why?.key === key ? why.slot : null;

  const noSlots = noSlotsReason(config, dateStr, slots);
  if (noSlots)
    return (
      <NoSlotsNotice
        config={config}
        dateStr={dateStr}
        service={service}
        barberName={barberName}
        reason={noSlots}
      />
    );

  const anyBlocked = slots.some((s) => !s.available);
  const isLong = (service?.durationMin ?? 0) > SLOT_STEP_MIN;

  return (
    <div>
      {/* Tres columnas en celular: con cuatro, "10:00 a.m." no cabía en la celda
          y se salía del botón. */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {slots.map((s) =>
          s.available ? (
            <button
              key={s.startMin}
              type="button"
              onClick={() => {
                setWhy(null);
                onSelect(s);
              }}
              className={[
                "rounded-lg border py-2 font-mono text-sm transition-colors",
                selectedMin === s.startMin
                  ? "border-brand bg-brand text-white"
                  : "border-brand/50 bg-brand-tint text-brand hover:bg-brand hover:text-white",
              ].join(" ")}
            >
              {s.label}
            </button>
          ) : (
            <button
              key={s.startMin}
              type="button"
              onClick={() => setWhy({ key, slot: s })}
              aria-label={`${s.label} — ver por qué no se puede`}
              className={[
                "rounded-lg border py-2 text-center font-mono text-sm line-through transition-colors",
                shown?.startMin === s.startMin
                  ? "border-gold/60 bg-gold-tint text-gold-deep"
                  : "border-line bg-line/40 text-muted/60 hover:border-gold/50",
              ].join(" ")}
            >
              {s.label}
            </button>
          ),
        )}
      </div>

      {shown ? (
        <div className="mt-3">
          <SlotBlockedNotice
            config={config}
            slot={shown}
            service={service}
            barberName={barberName}
          />
        </div>
      ) : (
        anyBlocked &&
        isLong && (
          <p className="mt-2 text-xs text-muted">
            {service?.label} ocupa {formatDuration(service?.durationMin ?? 0)}{" "}
            seguidas. Tocá una hora en gris para ver por qué no se puede.
          </p>
        )
      )}
    </div>
  );
}

function ModalError({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-xl border border-brand/30 bg-brand-tint px-4 py-2.5 text-sm text-brand-deep">
      {children}
    </p>
  );
}

// Trae la carga del día (bloqueos + citas) de UNA estilista. Se usa para
// deshabilitar los horarios bloqueados o llenos al crear/reagendar. El filtro es
// explícito: la dueña lee las filas de todo el salón, y sin acotar por barbero
// la disponibilidad de una saldría contaminada con las citas de las otras.
//
// `excludeId` saca del cálculo la cita que se está moviendo: si no, se choca
// consigo misma y el día entero se ve ocupado. Es la misma excepción que hace el
// trigger de la base (`a.id <> new.id`).
function useDayLoad(
  supabase: SupabaseClient,
  tz: string,
  barberId: string,
  excludeId?: string,
) {
  return useCallback(
    async (d: string): Promise<BusyRow[]> => {
      const dayStart = shopInstant(d, 0, tz).toISOString();
      const dayEnd = shopInstant(addDaysStr(d, 1), 0, tz).toISOString();
      let q = supabase
        .from("appointments")
        .select("start_time, end_time, kind")
        .eq("barber_id", barberId)
        .lt("start_time", dayEnd)
        .gt("end_time", dayStart);
      if (excludeId) q = q.neq("id", excludeId);
      const { data, error } = await q;
      if (error) console.error("No se pudo cargar la disponibilidad:", error.message);
      return ((data ?? []) as {
        start_time: string;
        end_time: string;
        kind: string;
      }[]).map((r) => ({
        start: new Date(r.start_time),
        end: new Date(r.end_time),
        kind: r.kind === "block" ? "block" : "booking",
      }));
    },
    [supabase, tz, barberId, excludeId],
  );
}

/**
 * El aviso del servidor al crear la cita. Los mensajes de la base ya vienen
 * legibles, pero el del cupo ("No hay campo en ese horario") es demasiado seco
 * para un servicio de 4 h: pasa cuando otra clienta agendó ese rato mientras la
 * administradora llenaba el formulario, y hay que decirle qué hacer.
 */
function newAppointmentError(
  message: string,
  service: SalonService | null,
  barberName: string,
): string {
  if (/no hay campo|bloqueado/i.test(message)) {
    const largo = service ? ` (${formatDuration(service.durationMin)})` : "";
    return (
      `Alguien tomó ese horario mientras llenabas la cita. ` +
      `${service?.label ?? "El servicio"}${largo} ya no cabe en la agenda de ` +
      `${barberName} a esa hora: elegí otro horario.`
    );
  }
  return message || "No se pudo crear la cita.";
}

/* ------------------------------------------------------------ new modal */

function NewAppointmentModal({
  supabase,
  config,
  barberId,
  barberName,
  isAdmin,
  defaultDate,
  onClose,
  onDone,
}: {
  supabase: SupabaseClient;
  config: SalonConfig;
  barberId: string;
  /** Nombre de la agenda que se está llenando: los avisos de choque hablan de
   *  "la agenda de Lineth", no de una estilista sin nombre. */
  barberName: string;
  isAdmin: boolean;
  defaultDate: string;
  onClose: () => void;
  onDone: (d: string) => void;
}) {
  // El primer servicio DE ESA ESTILISTA: `config.services[0]` podría ser uno que
  // no realiza, y la base rechazaría la cita al guardar.
  const [service, setService] = useState<string>(
    () =>
      servicesForBarber(
        config,
        config.barbers.find((b) => b.id === barberId) ?? null,
        { admin: isAdmin },
      )[0]?.slug ?? "",
  );
  const [date, setDate] = useState(() => seedDate(config, defaultDate));
  const bookWin = useMemo(
    () => adminBookingWindow(config.timezone),
    [config.timezone],
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fetchLoad = useDayLoad(supabase, config.timezone, barberId);
  const serviceInfo: SalonService | null = service
    ? getService(config, service) ?? null
    : null;

  useEffect(() => {
    let alive = true;
    (async () => {
      const busy = await fetchLoad(date);
      if (!alive) return;
      setSlot(null);
      setSlots(generateDaySlots(config, date, serviceInfo, busy));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, service, fetchLoad]);

  async function submit() {
    if (!slot) {
      setError("Elegí un horario.");
      return;
    }
    if (name.trim().length === 0) {
      setError("Escribí el nombre del cliente.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.rpc("book_appointment", {
      p_slug: config.slug,
      p_barber_id: barberId,
      p_start: slot.start.toISOString(),
      p_service_slug: service,
      p_name: name.trim(),
      p_phone: phone.trim(),
    });
    setSubmitting(false);
    if (error) {
      setError(newAppointmentError(error.message, serviceInfo, barberName));
      return;
    }
    onDone(date);
  }

  return (
    <Modal title="Nueva cita" onClose={onClose}>
      <div className="grid grid-cols-1 gap-4">
        <ServiceSelect
          config={config}
          barberId={barberId}
          admin={isAdmin}
          value={service}
          onChange={setService}
        />

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Día</p>
          <MonthCalendar
            config={config}
            value={date}
            onChange={setDate}
            window={bookWin}
          />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Horario</p>
          <SlotButtons
            config={config}
            dateStr={date}
            service={serviceInfo}
            barberName={barberName}
            slots={slots}
            selectedMin={slot?.startMin ?? null}
            onSelect={setSlot}
          />
        </div>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">
            Nombre del cliente
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl border border-line px-4 py-2.5 text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">
            Teléfono
          </span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-xl border border-line px-4 py-2.5 text-ink outline-none focus:border-brand"
          />
        </label>

        {error && <ModalError>{error}</ModalError>}

        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="mt-1 inline-flex items-center justify-center rounded-full bg-brand px-6 py-3 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep disabled:opacity-60"
        >
          {submitting ? "Guardando…" : "Crear cita"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- block modal */

// Tope del bloqueo por rango. Va suelto y NO atado al horizonte del cliente: con
// el horizonte en un año, un rango mal tipeado borraría meses de agenda de un
// botón, y para deshacerlo hay que ir cita por cita. Unas vacaciones largas
// caben de sobra en tres meses.
const MAX_BLOCK_SPAN_DAYS = 90;

type BlockMode = "time" | "days";

function BlockModal({
  supabase,
  config,
  barberId,
  defaultDate,
  onClose,
  onDone,
}: {
  supabase: SupabaseClient;
  config: SalonConfig;
  barberId: string;
  defaultDate: string;
  onClose: () => void;
  onDone: (d: string) => void;
}) {
  const [mode, setMode] = useState<BlockMode>("time");
  const [date, setDate] = useState(() => seedDate(config, defaultDate));
  const win = hoursWindow(config);
  // Horario del día elegido (o la ventana más amplia si cae en un día cerrado).
  const hours = dayHours(config, date) ?? win;
  const [startMin, setStartMin] = useState(hours.openMin);
  const [endMin, setEndMin] = useState(hours.openMin + SLOT_STEP_MIN);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Rango de días completos (vacaciones, viajes).
  const [fromDate, setFromDate] = useState(() => seedDate(config, defaultDate));
  const [toDate, setToDate] = useState(() => seedDate(config, defaultDate));
  // El conteo viaja con el rango que lo produjo, para no mostrar el número del
  // rango anterior mientras la consulta del nuevo sigue en vuelo.
  const [conflicts, setConflicts] = useState<{ key: string; count: number } | null>(
    null,
  );

  const tz = config.timezone;
  const blockWindow: BookingWindow = useMemo(() => adminBookingWindow(tz), [tz]);

  const openDays = openDaysInRange(config, fromDate, toDate);
  const rangeKey = `${fromDate}:${toDate}`;
  const conflictCount = conflicts?.key === rangeKey ? conflicts.count : 0;

  // Bloquear NO cancela lo que ya está agendado, así que hay que decírselo antes
  // de que se vaya de vacaciones creyendo que la agenda quedó limpia.
  useEffect(() => {
    if (mode !== "days" || toDate < fromDate) return;
    let cancelled = false;
    (async () => {
      const { count, error } = await supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("kind", "booking")
        .eq("barber_id", barberId)
        .gte("start_time", shopInstant(fromDate, 0, tz).toISOString())
        .lt("start_time", shopInstant(addDaysStr(toDate, 1), 0, tz).toISOString());
      if (error) console.error("No se pudo revisar el rango:", error.message);
      if (!cancelled) setConflicts({ key: `${fromDate}:${toDate}`, count: count ?? 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, mode, fromDate, toDate, barberId, tz]);

  // Al cambiar de día, reencuadrá el rango dentro del horario de ese día.
  function pickDate(d: string) {
    const h = dayHours(config, d) ?? win;
    setDate(d);
    setStartMin(h.openMin);
    setEndMin(h.openMin + SLOT_STEP_MIN);
  }

  function pickFrom(d: string) {
    setFromDate(d);
    setError(null);
    // Arrastrar el final evita el estado inválido de "hasta" antes que "desde".
    if (toDate < d) setToDate(d);
  }

  const startOptions: number[] = [];
  for (let m = hours.openMin; m <= hours.closeMin - SLOT_STEP_MIN; m += SLOT_STEP_MIN)
    startOptions.push(m);
  const endOptions: number[] = [];
  for (let m = startMin + SLOT_STEP_MIN; m <= hours.closeMin; m += SLOT_STEP_MIN)
    endOptions.push(m);

  async function submit() {
    if (endMin <= startMin) {
      setError("La hora de fin debe ser posterior al inicio.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.from("appointments").insert({
      barber_id: barberId,
      start_time: shopInstant(date, startMin, config.timezone).toISOString(),
      end_time: shopInstant(date, endMin, config.timezone).toISOString(),
      kind: "block",
    });
    setSubmitting(false);
    if (error) {
      setError("No se pudo bloquear. Intentá de nuevo.");
      return;
    }
    onDone(date);
  }

  // Un bloqueo por día abierto, de la apertura al cierre. Los días cerrados se
  // saltean: ya son inasignables, no hace falta gastar una fila en ellos.
  async function submitRange() {
    if (toDate < fromDate) {
      setError("El día final debe ser posterior al inicial.");
      return;
    }
    const span = rangeLengthDays(fromDate, toDate);
    if (span > MAX_BLOCK_SPAN_DAYS) {
      setError(
        `No se pueden bloquear más de ${MAX_BLOCK_SPAN_DAYS} días de una vez.`,
      );
      return;
    }
    if (openDays.length === 0) {
      setError("No hay días abiertos en ese rango.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const rows = openDays.flatMap((d) => {
      const h = dayHours(config, d);
      if (!h) return [];
      return [
        {
          barber_id: barberId,
          start_time: shopInstant(d, h.openMin, tz).toISOString(),
          end_time: shopInstant(d, h.closeMin, tz).toISOString(),
          kind: "block",
        },
      ];
    });
    const { error } = await supabase.from("appointments").insert(rows);
    setSubmitting(false);
    if (error) {
      setError("No se pudieron crear los bloqueos. Intentá de nuevo.");
      return;
    }
    onDone(fromDate);
  }

  return (
    <Modal title="Bloquear horario" onClose={onClose}>
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-2 gap-1 rounded-full border border-line bg-line/30 p-1">
          <ModeTab
            active={mode === "time"}
            onClick={() => {
              setMode("time");
              setError(null);
            }}
          >
            Un rato
          </ModeTab>
          <ModeTab
            active={mode === "days"}
            onClick={() => {
              setMode("days");
              setError(null);
            }}
          >
            Días completos
          </ModeTab>
        </div>

        {mode === "time" ? (
          <>
            <p className="text-sm text-muted">
              Reservá tiempo para vos. Los clientes no podrán agendar dentro de
              ese rango.
            </p>

            <div>
              <p className="mb-2 text-sm font-medium text-ink">Día</p>
              <MonthCalendar
                config={config}
                value={date}
                onChange={pickDate}
                window={blockWindow}
              />
            </div>

            <div className="grid grid-cols-1 gap-3">
              <label className="block min-w-0">
                <span className="mb-1.5 block text-sm font-medium text-ink">
                  Desde
                </span>
                <select
                  value={startMin}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setStartMin(v);
                    if (endMin <= v) setEndMin(v + SLOT_STEP_MIN);
                  }}
                  className="w-full min-w-0 rounded-xl border border-line px-3 py-2.5 font-mono text-ink outline-none focus:border-brand"
                >
                  {startOptions.map((m) => (
                    <option key={m} value={m}>
                      {minutesToLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="mb-1.5 block text-sm font-medium text-ink">
                  Hasta
                </span>
                <select
                  value={endMin}
                  onChange={(e) => setEndMin(Number(e.target.value))}
                  className="w-full min-w-0 rounded-xl border border-line px-3 py-2.5 font-mono text-ink outline-none focus:border-brand"
                >
                  {endOptions.map((m) => (
                    <option key={m} value={m}>
                      {minutesToLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {error && <ModalError>{error}</ModalError>}

            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="mt-1 inline-flex items-center justify-center rounded-full bg-brand px-6 py-3 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep disabled:opacity-60"
            >
              {submitting ? "Guardando…" : "Bloquear"}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">
              Cerrá varios días de corrido (vacaciones, un viaje). Se bloquea el
              día completo, de la apertura al cierre.
            </p>

            <div>
              <p className="mb-2 text-sm font-medium text-ink">Desde</p>
              <MonthCalendar
                config={config}
                value={fromDate}
                onChange={pickFrom}
                window={blockWindow}
              />
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-ink">Hasta</p>
              <MonthCalendar
                config={config}
                value={toDate}
                onChange={(d) => {
                  setToDate(d);
                  setError(null);
                }}
                window={{ minDate: fromDate, maxDate: blockWindow.maxDate }}
              />
            </div>

            <p className="text-sm text-muted">
              {openDays.length === 0
                ? "No hay días abiertos en ese rango."
                : `Se van a cerrar ${openDays.length} ${
                    openDays.length === 1 ? "día" : "días"
                  }: ${longDateLabel(openDays[0])}${
                    openDays.length > 1
                      ? ` → ${longDateLabel(openDays[openDays.length - 1])}`
                      : ""
                  }.`}
            </p>

            {conflictCount > 0 && (
              <p className="rounded-xl border border-gold/40 bg-gold-tint px-4 py-2.5 text-sm text-gold-deep">
                Ya tenés {conflictCount}{" "}
                {conflictCount === 1 ? "cita agendada" : "citas agendadas"} en
                ese rango. Bloquear no{" "}
                {conflictCount === 1 ? "la" : "las"} cancela: avisale a{" "}
                {conflictCount === 1 ? "ese cliente" : "esos clientes"} y{" "}
                {conflictCount === 1 ? "eliminala" : "eliminalas"} a mano.
              </p>
            )}

            {error && <ModalError>{error}</ModalError>}

            <button
              type="button"
              onClick={submitRange}
              disabled={submitting || openDays.length === 0}
              className="mt-1 inline-flex items-center justify-center rounded-full bg-brand px-6 py-3 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep disabled:opacity-60"
            >
              {submitting
                ? "Guardando…"
                : `Bloquear ${openDays.length} ${
                    openDays.length === 1 ? "día" : "días"
                  }`}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "rounded-full px-4 py-2 text-sm font-medium transition-colors",
        active ? "bg-paper text-ink shadow-sm" : "text-muted hover:text-ink",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------- reschedule modal */

function RescheduleModal({
  supabase,
  config,
  appt,
  barberName,
  onClose,
  onDone,
}: {
  supabase: SupabaseClient;
  config: SalonConfig;
  appt: Appointment;
  barberName: string;
  onClose: () => void;
  onDone: (d: string) => void;
}) {
  // Día calendario de la cita en la zona del salón (YYYY-MM-DD).
  const startDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
  }).format(new Date(appt.start_time));

  const [date, setDate] = useState(() => seedDate(config, startDateStr));
  const bookWin = useMemo(
    () => adminBookingWindow(config.timezone),
    [config.timezone],
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fetchLoad = useDayLoad(
    supabase,
    config.timezone,
    appt.barber_id,
    appt.id,
  );
  const serviceInfo: SalonService | null = appt.service_slug
    ? getService(config, appt.service_slug) ?? null
    : null;

  useEffect(() => {
    let alive = true;
    (async () => {
      const busy = await fetchLoad(date);
      if (!alive) return;
      setSlot(null);
      setSlots(generateDaySlots(config, date, serviceInfo, busy));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, fetchLoad]);

  async function submit() {
    if (!slot) {
      setError("Elegí un nuevo horario.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const { error } = await supabase
      .from("appointments")
      .update({
        start_time: slot.start.toISOString(),
        end_time: slot.end.toISOString(),
      })
      .eq("id", appt.id);
    setSubmitting(false);
    if (error) {
      setError("No se pudo reagendar. Intentá de nuevo.");
      return;
    }
    onDone(date);
  }

  return (
    <Modal title="Reagendar cita" onClose={onClose}>
      <div className="grid grid-cols-1 gap-4">
        <div className="rounded-xl border border-line bg-line/30 px-4 py-3 text-sm">
          <span className="font-medium text-ink">{appt.client_name}</span>
          <span className="text-muted">
            {" "}
            · {formatShopTime(appt.start_time, config.timezone)} → mover a…
          </span>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Día</p>
          <MonthCalendar
            config={config}
            value={date}
            onChange={setDate}
            window={bookWin}
          />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Nuevo horario</p>
          <SlotButtons
            config={config}
            dateStr={date}
            service={serviceInfo}
            barberName={barberName}
            slots={slots}
            selectedMin={slot?.startMin ?? null}
            onSelect={setSlot}
          />
        </div>

        {error && <ModalError>{error}</ModalError>}

        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="mt-1 inline-flex items-center justify-center rounded-full bg-brand px-6 py-3 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep disabled:opacity-60"
        >
          {submitting ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------- edit service modal */

// Cambiar el servicio de una cita ya creada (p. ej. el cliente reservó un corte y
// terminó llevándose corte + barba). Mantiene la hora de inicio; recalcula
// end_time con la duración del nuevo servicio. El precio no se guarda en la cita
// (se deriva del catálogo), así que la agenda y el panel semanal se ajustan solos.
function EditServiceModal({
  supabase,
  config,
  appt,
  isAdmin,
  onClose,
  onDone,
}: {
  supabase: SupabaseClient;
  config: SalonConfig;
  appt: Appointment;
  isAdmin: boolean;
  onClose: () => void;
  onDone: (d: string) => void;
}) {
  // Día calendario de la cita en la zona del salón (para recargar ese día al terminar).
  const dayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
  }).format(new Date(appt.start_time));

  const [service, setService] = useState<string>(
    appt.service_slug ?? config.services[0]?.slug ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Mantener la hora de inicio y estirar el fin puede empujar la cita dentro del
  // almuerzo o pasarla del cierre. La base lo rechaza; acá se deshabilitan esas
  // opciones para que no llegue a intentarlo.
  const startMin = shopMinutes(appt.start_time, config.timezone);
  const doesNotFit = (s: SalonService) =>
    !fitsInHours(config, dayStr, startMin, s);

  const unchanged = service === appt.service_slug;
  const chosen = getService(config, service);
  const chosenFits = chosen ? !doesNotFit(chosen) : false;

  async function submit() {
    if (!service) {
      setError("Elegí un servicio.");
      return;
    }
    if (chosen && !chosenFits) {
      setError("Ese servicio no cabe a esta hora. Reagendá la cita primero.");
      return;
    }
    setSubmitting(true);
    setError(null);
    // Recalcula el fin con la duración del nuevo servicio, manteniendo el inicio.
    const dur = getService(config, service)?.durationMin ?? SLOT_STEP_MIN;
    const newEnd = new Date(
      new Date(appt.start_time).getTime() + dur * 60_000,
    ).toISOString();
    const { error } = await supabase
      .from("appointments")
      .update({ service_slug: service, end_time: newEnd })
      .eq("id", appt.id);
    setSubmitting(false);
    if (error) {
      // Los mensajes del trigger del servidor ya vienen legibles (p. ej. si el
      // servicio más largo se solapa con otra cita: "No hay campo en ese horario").
      setError(error.message || "No se pudo cambiar el servicio. Intentá de nuevo.");
      return;
    }
    onDone(dayStr);
  }

  return (
    <Modal title="Cambiar servicio" onClose={onClose}>
      <div className="grid grid-cols-1 gap-4">
        <div className="rounded-xl border border-line bg-line/30 px-4 py-3 text-sm">
          <span className="font-medium text-ink">{appt.client_name}</span>
          <span className="text-muted">
            {" "}
            · {longDateLabel(dayStr)} ·{" "}
            {formatShopTime(appt.start_time, config.timezone)}
          </span>
        </div>

        <ServiceSelect
          config={config}
          barberId={appt.barber_id}
          admin={isAdmin}
          value={service}
          onChange={setService}
          notFitting={doesNotFit}
        />

        {error && <ModalError>{error}</ModalError>}

        <button
          type="button"
          onClick={submit}
          disabled={submitting || unchanged || !chosenFits}
          className="mt-1 inline-flex items-center justify-center rounded-full bg-brand px-6 py-3 font-display font-semibold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep disabled:opacity-60"
        >
          {submitting ? "Guardando…" : "Guardar servicio"}
        </button>
      </div>
    </Modal>
  );
}
