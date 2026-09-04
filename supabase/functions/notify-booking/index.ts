import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

// Avisa a la estilista cuando entra una reserva, disparado por el trigger
// notify_booking() vía pg_net en la base multitenant compartida.
//
// MULTITENANT: resuelve el salón desde la cita y saca todo de la base:
//   * label del servicio -> salon_services (catálogo por salón)
//   * Web Push (VAPID)   -> app_config GLOBAL (un solo par para todo el SaaS)
//
// CANAL ÚNICO: Web Push. La rama de correo (Resend) se quitó porque no estaba
// configurada en ningún salón — 0 de 5 con API key y 0 estilistas con
// notify_email — así que nunca llegó a mandar nada. El respaldo real cuando el
// push falla es la campanita del panel, que se llena por Realtime.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest(path: string, init?: RequestInit): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

/* ------------------------------------------------------------------ auth --*/

/**
 * Solo el trigger de la base puede disparar esta función.
 *
 * `verify_jwt` NO alcanza: acepta cualquier JWT firmado por el proyecto,
 * incluida la anon key que viaja en el bundle del navegador. Sin este chequeo,
 * cualquiera que mire el JS de la app puede llamar al endpoint con el
 * `appointment_id` de su propia reserva y reenviar el push cuantas veces quiera
 * (spam al celular de la estilista).
 *
 * El secreto vive en `app_config`, que tiene RLS activa SIN policies: ni anon
 * ni authenticated lo leen. Solo la service_role (esta función) y las funciones
 * SECURITY DEFINER (el trigger). Nunca viaja al navegador.
 *
 * Deliberadamente NO se usa la service_role key como secreto: si este valor se
 * filtrara, solo sirve para disparar una notificación, no para tocar datos.
 */
function sameSecret(a: string, b: string): boolean {
  // Comparación de tiempo constante para no filtrar el secreto por tiempos.
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Se cachea por instancia: el secreto solo cambia si alguien lo rota a mano.
// Un fallo de lectura NO se cachea — si no, un error de red transitorio dejaría
// la instancia rechazando todo hasta morir.
let cachedSecret = "";
async function notifySecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const rows = await rest(`app_config?name=eq.notify_shared_secret&select=value`);
  const value = rows[0]?.value ?? "";
  if (value) cachedSecret = value;
  return value;
}

/** UUID v1-v5 canónico. Todo id que se interpole en una query va por acá. */
function isUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(v)
  );
}

/* --------------------------------------------------------------- helpers --*/

function fmt(dt: string, tz: string) {
  const d = new Date(dt);
  const date = new Intl.DateTimeFormat("es-CR", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
  const time = new Intl.DateTimeFormat("es-CR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return { date, time };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* -------------------------------------------------------------- Web Push --*/

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 2 ? "==" : b64.length % 4 === 3 ? "=" : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Construye el par de JWK que espera @negrel/webpush a partir de las claves
// VAPID en formato "raw" (público = punto 0x04||x||y en base64url; privado = d).
function vapidJwks(pub: string, priv: string) {
  const raw = b64urlToBytes(pub); // 65 bytes: 0x04 || x(32) || y(32)
  const x = bytesToB64url(raw.slice(1, 33));
  const y = bytesToB64url(raw.slice(33, 65));
  return {
    publicKey: { kty: "EC", crv: "P-256", x, y, ext: true, key_ops: ["verify"] },
    privateKey: { kty: "EC", crv: "P-256", x, y, d: priv, ext: true, key_ops: ["sign"] },
  } as { publicKey: JsonWebKey; privateKey: JsonWebKey };
}

type PushRow = { id: string; endpoint: string; p256dh: string; auth: string };

// Se notifica al SALÓN, no a la estilista de la cita: con varias estilistas, la
// única que inicia sesión es la dueña, así que las suscripciones del salón son
// las suyas. Con una sola estilista el conjunto es idéntico.
async function sendPush(
  salonId: string,
  cfg: Map<string, string>,
  payload: { title: string; body: string; url: string },
): Promise<{ sent: number; removed: number; skipped?: string }> {
  const pub = Deno.env.get("VAPID_PUBLIC") ?? cfg.get("vapid_public_key") ?? "";
  const privRaw = Deno.env.get("VAPID_PRIVATE") ?? cfg.get("vapid_private_key") ?? "";
  const subject =
    Deno.env.get("VAPID_SUBJECT") ?? cfg.get("vapid_subject") ?? "mailto:notificaciones@example.com";
  if (!pub || !privRaw) return { sent: 0, removed: 0, skipped: "no vapid keys" };

  const subs = (await rest(
    `push_subscriptions?salon_id=eq.${encodeURIComponent(salonId)}` +
      `&select=id,endpoint,p256dh,auth`,
  )) as PushRow[];
  if (subs.length === 0) return { sent: 0, removed: 0, skipped: "no subscriptions" };

  const vapidKeys = await webpush.importVapidKeys(vapidJwks(pub, privRaw), {
    extractable: false,
  });
  const server = await webpush.ApplicationServer.new({
    contactInformation: subject,
    vapidKeys,
  });

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subs.map(async (row) => {
      try {
        const subscriber = server.subscribe({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        });
        await subscriber.pushTextMessage(body, {});
        sent++;
      } catch (e) {
        // 404/410 => la suscripción ya no existe: la limpiamos para no reintentar.
        const status = (e as { response?: Response })?.response?.status;
        if (status === 404 || status === 410) {
          await rest(
            `push_subscriptions?id=eq.${encodeURIComponent(row.id)}`,
            { method: "DELETE" },
          );
          removed++;
        } else {
          console.error("push failed:", String(e));
        }
      }
    }),
  );

  return { sent, removed };
}

/* --------------------------------------------------------------- handler --*/

Deno.serve(async (req) => {
  try {
    // Sin header no se consulta la base: si no, un request anónimo sería
    // amplificación gratis contra Postgres.
    const provided = req.headers.get("x-notify-secret") ?? "";
    if (!provided || !sameSecret(provided, await notifySecret())) {
      return json({ ok: false, reason: "forbidden" }, 403);
    }

    const payload = await req.json().catch(() => ({}));
    const id = payload.appointment_id ?? payload.record?.id;
    // Validar el UUID no es cosmético: `id` se interpola en el query string de
    // PostgREST, así que un valor como "x&or=(kind.eq.booking)" reescribiría los
    // filtros de una consulta que corre con service_role (inyección PostgREST).
    if (!isUuid(id)) {
      return json({ ok: false, reason: "missing or invalid appointment_id" }, 400);
    }

    // La cita trae su salón; join a barbers (nombre) y salons (timezone).
    const rows = await rest(
      `appointments?id=eq.${encodeURIComponent(id)}` +
        `&select=id,salon_id,kind,client_name,service_slug,start_time,barbers(name),salons(timezone)`,
    );
    const appt = rows[0];
    if (!appt) return json({ ok: false, reason: "appointment not found" });
    if (appt.kind !== "booking") return json({ ok: true, reason: "not a booking" });

    const barber = Array.isArray(appt.barbers) ? appt.barbers[0] : appt.barbers;
    const salon = Array.isArray(appt.salons) ? appt.salons[0] : appt.salons;
    const tz = salon?.timezone ?? "America/Costa_Rica";

    // Label del servicio, desde el catálogo del salón (no hardcode).
    let svc = appt.service_slug ?? "Servicio";
    // `service_slug` lo elige quien reserva, así que también se codifica antes
    // de pegarlo en el filtro (mismo riesgo de inyección PostgREST que el id).
    if (appt.service_slug && isUuid(appt.salon_id)) {
      const svcRows = await rest(
        `salon_services?salon_id=eq.${encodeURIComponent(appt.salon_id)}` +
          `&slug=eq.${encodeURIComponent(appt.service_slug)}&select=label`,
      );
      if (svcRows[0]) svc = svcRows[0].label ?? svc;
    }

    // VAPID global del SaaS.
    const cfgRows = await rest(`app_config?select=name,value`);
    const cfg = new Map(
      cfgRows.map((r: { name: string; value: string }) => [r.name, r.value]),
    );

    const { date, time } = fmt(appt.start_time, tz);

    let pushResult: unknown = { skipped: true };
    try {
      pushResult = await sendPush(appt.salon_id, cfg, {
        title: "Nueva cita",
        body: `${appt.client_name ?? "Cliente"} · ${barber?.name ?? "—"} · ${date} ${time} · ${svc}`,
        url: "/barbero",
      });
    } catch (e) {
      console.error("push failed:", String(e));
      pushResult = { ok: false, error: "push failed" };
    }

    return json({ ok: true, push: pushResult });
  } catch (e) {
    // Nunca devolver el error crudo: delata rutas internas, versiones y esquema.
    console.error("notify-booking failed:", String(e));
    return json({ ok: false, error: "internal error" }, 500);
  }
});
