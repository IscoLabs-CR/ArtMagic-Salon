# Art & Magic Salon — App de reservas

Web app para reservar citas de barbería/salón. Los **clientes agendan sin crear
cuenta** desde su teléfono; el **barbero/estilista** gestiona su agenda desde un
portal privado.

Parte de un **SaaS multitenant**: todos los salones comparten una base Supabase
(`isco-salones`) aislada por RLS. Este despliegue sirve UN salón, identificado por
`NEXT_PUBLIC_SALON_SLUG`. **Toda la config (servicios, precios, horario, nombre) se
lee en vivo de la base** con el RPC `get_salon_public` — cambiarla no requiere redeploy.

## Este despliegue

- **Salón:** Art & Magic Salon · slug `art-magic-salon` · zona `America/Costa_Rica`.
- **Equipo (3 estilistas, agendas independientes):** Azucena Mora *(Estilista y
  maquillista, **dueña** — único login, `is_admin`)*, Lineth Mora *(Estilista)* y
  Melissa Artavia *(Asistente estilista)*. La especialidad sale del campo
  `barbers.role` y se muestra bajo el nombre en el wizard.
- **Horario:** Lun–Vie 8:00–17:00 con almuerzo 12:00–13:00; Sáb 8:00–15:00 jornada
  continua; Dom cerrado. `last_start_min` queda en NULL a propósito: la última hora
  que se ofrece sale de que el servicio termine antes del cierre (16:00 entre
  semana y 14:00 el sábado para uno de 60 min).
- **Cupo:** `max_bookings_per_slot = 1` — el paralelismo sale de tener 3 estilistas,
  no de varios cupos por espacio.
- **Avisos:** solo push (PWA). Sin Resend ni correo: `notify_email` en null.
- **Marca:** `Art-Logo.jpeg` es la fuente del logo y de los iconos PWA
  (`scripts/gen-brand-icons.ps1` los regenera); `Background.jpeg` → `public/background.jpg`
  es el fondo `.brand-bg` de la landing, el wizard y el login. Paleta negro + dorado
  en `tailwind.config.ts`.
- **Login de la dueña:** usuario `demo` (la contraseña no se versiona).

- **Servicios:** 9, en 3 categorías (Cortes / Tratamientos capilares / Belleza), de 30
  a 120 min. **Sin precio** — la clienta trabaja por cotización, así que la UI no
  pinta ninguna línea de precio ni montos en el resumen semanal. Si algún día se
  cargan los `price_crc`, vuelven solos (**sin redeploy**).
- **Catálogo por estilista:** cada una hace lo suyo y la restricción es estricta —
  Azucena 8 servicios, Lineth 4, Melissa 3. Vive en `barber_services`; el cliente solo
  ve lo de la estilista que eligió y la base rechaza cualquier otro par. Ver
  `supabase/PROVISION.md`.
- **Candado de horario:** `salons.enforce_hours = true`. Ningún servicio puede caer en
  el almuerzo ni pasarse del cierre por **ningún** camino, incluido el `update` directo
  que hace el panel al cambiar el servicio de una cita.
- **Servicios por teléfono:** 8 tratamientos largos (2:30 a 5 h — tintes, balayage,
  alisados, corrección de color) **no se reservan en línea**. Al entrar al paso del
  servicio sale un aviso que los lista y pide llamar al salón, con botón de llamada al
  fijo (`theme.phone` = `2417-1078`). Están en `theme.call_to_book`, no en
  `salon_services`. Ver `supabase/PROVISION.md`.

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript**
- **Tailwind CSS v3** (NO v4 — su binario nativo se bloquea en Windows con
  Application Control)
- **Supabase**: Postgres + Auth + Realtime + Edge Functions (base compartida)
- **@supabase/ssr** para la sesión del barbero — protección de rutas en `src/proxy.ts`
  (Next 16 renombró `middleware` → `proxy`)
- **date-fns / date-fns-tz** para la zona horaria (viene en la config del salón)

## Config del salón

- La app trae la config con `getSalonConfig()` (`src/lib/salon.ts`) → `get_salon_public`.
- **Servicios/precios/duración, categorías, horario, nombre, zona y tema** viven en
  la base (`salon_services`, `salon_categories`, `salon_hours`, `salons`), no en el
  código. `src/lib/booking.ts` solo tiene lógica pura que opera sobre esa config.
- **Rejilla:** cada 30 min. La disponibilidad respeta la `duration_min` del servicio
  y el `max_bookings_per_slot` del salón.
- **Horizonte de reserva:** el cliente elige el día en un calendario mensual
  (`src/components/MonthCalendar.tsx`) que llega hasta `theme.booking_horizon_days`
  días (60 por defecto; **este salón está en 365** — hay clientas que agendan sus
  tratamientos largos con ocho meses de anticipación). Se cambia en la base, sin
  redeploy.
- **Datos del cliente al reservar:** nombre + teléfono (sin login).

## Panel del barbero

Agenda del día en Realtime: crear, eliminar y reagendar citas, y **cambiar el
servicio** de una ya creada (mantiene el inicio y recalcula el fin; no re-envía la
push, porque el aviso se dispara solo al insertar). Tocar la fecha despliega un
calendario mensual para saltar a cualquier día del año sin recorrerlo con las
flechas; ahí sí se pueden abrir los días cerrados, que es donde se ven los
bloqueos. Los bloqueos van por horario suelto o por **día completo** para
vacaciones — un rango con dos calendarios (tope `MAX_BLOCK_SPAN_DAYS`, 90 días)
que crea un bloqueo por cada día abierto y avisa de las citas ya agendadas que
caen adentro, porque bloquear **no** las cancela. Además, panel semanal de
ingresos.

## Seguridad y datos

- Aislamiento por RLS: cada barbero tiene `salon_id` en el JWT; solo ve/gestiona sus
  filas. El anónimo **no** lee tablas directo — usa los RPC `SECURITY DEFINER`
  `get_salon_public`, `get_day_load` y `book_appointment`.
- Login por **usuario/contraseña**: el usuario se mapea a `usuario@<slug>.local`
  (Supabase Auth usa correo por detrás, invisible al barbero).

## Correr localmente

```bash
npm install
npm run dev   # http://localhost:3000
```

`.env.local` (copiá `env.local.example`): la URL, la anon key y la VAPID pública ya
vienen puestas (base compartida, iguales para todos). Solo cambia
`NEXT_PUBLIC_SALON_SLUG`.

**Rutas:** `/` · `/reservar` · `/barbero/login` · `/barbero`.

## Notificaciones push (PWA)

La app es instalable (**Agregar a pantalla de inicio**) y envía una **notificación
push del sistema** al barbero por cada reserva, aunque tenga la app cerrada. La Edge
Function global `notify-booking` manda push (VAPID global). Es el **único** canal: la
rama de correo (Resend) se quitó porque no estaba configurada en ningún salón. El
respaldo cuando el push falla es la campanita del panel, que se llena por Realtime.

Solo el trigger `notify_booking()` puede invocar la Edge Function: manda el secreto
`notify_shared_secret` (guardado en `app_config`) en el header `x-notify-secret`.
`verify_jwt` por sí solo no alcanza, porque acepta la anon key, que es pública.

- **Manifest:** `src/app/manifest.ts` (`display: standalone`, abre en `/`) + logo e
  iconos en `public/` (generados con `node scripts/gen-icons.js public`).
- **Service worker:** `public/sw.js` (evento `push` + `notificationclick`).
- **Suscripción:** el barbero toca **"Activar notificaciones"** en `/barbero`
  (`src/lib/push.ts`); se guarda en `public.push_subscriptions` (RLS por barbero;
  el `salon_id` lo pone un trigger).

**iOS vs Android:** en Android el push anda incluso desde el navegador; en
**iPhone/iPad (iOS 16.4+)** el barbero debe instalar la app en la pantalla de inicio
y abrirla desde ese ícono antes de activar las notificaciones. Requiere **HTTPS**.
