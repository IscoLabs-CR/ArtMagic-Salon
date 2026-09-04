// Helpers de Web Push para el panel del barbero: registrar el service worker,
// suscribirse y guardar la suscripción en Supabase (tabla push_subscriptions).
// La Edge Function `notify-booking` lee esa tabla y envía el aviso por cada
// reserva. En iOS solo funciona con la app instalada en la pantalla de inicio.
import type { SupabaseClient } from "@supabase/supabase-js";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

// Convierte la clave pública VAPID (base64url) al Uint8Array que espera
// pushManager.subscribe().
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Backed by an explicit ArrayBuffer so el tipo calce con BufferSource
  // (applicationServerKey) sin ArrayBufferLike genérico.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// true cuando la web corre como app instalada (standalone). iOS exige esto para
// permitir push; en Android el push funciona incluso desde el navegador.
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Safari iOS expone esta propiedad no estándar.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !(window as unknown as { MSStream?: unknown }).MSStream
  );
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

// Guarda (o actualiza) la suscripción de este dispositivo. `endpoint` es UNIQUE
// en la tabla, así que el upsert nunca duplica filas por más veces que se llame.
async function saveSubscription(
  supabase: SupabaseClient,
  barberId: string,
  sub: PushSubscription,
) {
  const json = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  return supabase.from("push_subscriptions").upsert(
    {
      barber_id: barberId,
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
      user_agent: navigator.userAgent.slice(0, 300),
    },
    { onConflict: "endpoint" },
  );
}

// Registra el SW, pide permiso, se suscribe y guarda la suscripción para este
// barbero. Devuelve la suscripción o lanza un error con mensaje legible.
export async function subscribeBarber(
  supabase: SupabaseClient,
  barberId: string,
): Promise<PushSubscription> {
  if (!VAPID_PUBLIC_KEY) {
    throw new Error(
      "Falta configurar NEXT_PUBLIC_VAPID_PUBLIC_KEY. Avisá al administrador.",
    );
  }
  if (!isPushSupported()) {
    throw new Error("Este dispositivo o navegador no soporta notificaciones push.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      "No diste permiso para notificaciones. Activalo en los ajustes del navegador.",
    );
  }

  const reg = await getRegistration();
  await navigator.serviceWorker.ready;

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }));

  const { error } = await saveSubscription(supabase, barberId, sub);
  if (error) {
    throw new Error("No se pudo guardar la suscripción: " + error.message);
  }

  return sub;
}

/**
 * Confirma que la suscripción de este dispositivo esté realmente guardada en la
 * base, y la repone si no está.
 *
 * El permiso del navegador NO alcanza como señal: `notify-booking` borra la fila
 * de `push_subscriptions` cuando el navegador responde 404/410 (endpoint rotado,
 * app reinstalada, datos del sitio borrados), pero el permiso queda en "granted"
 * igual. Sin este chequeo el panel dice "activadas" mientras no llega ni un
 * aviso, y nadie se entera hasta que se pierde una cita.
 */
export async function syncSubscription(
  supabase: SupabaseClient,
  barberId: string,
): Promise<"on" | "off" | "error"> {
  const sub = await getExistingSubscription();
  const granted =
    typeof Notification !== "undefined" && Notification.permission === "granted";
  if (!sub || !granted) return "off";

  // La RLS acota el select a las filas de este barbero en su salón.
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("id")
    .eq("endpoint", sub.endpoint)
    .maybeSingle();
  if (error) {
    console.error("No se pudo verificar la suscripción push:", error.message);
    return "error";
  }
  if (data) return "on";

  // El dispositivo está suscrito pero la fila no está: la reponemos sola.
  const { error: saveError } = await saveSubscription(supabase, barberId, sub);
  if (saveError) {
    console.error("No se pudo reponer la suscripción push:", saveError.message);
    return "error";
  }
  return "on";
}

export async function unsubscribeBarber(supabase: SupabaseClient): Promise<void> {
  const sub = await getExistingSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
}
