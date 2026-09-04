# Provisión del salón (base multitenant compartida)

Esta app **NO tiene su propia base de datos**. Todos los salones/barberías viven
en un único proyecto Supabase compartido — **`isco-salones`**
(ref `icwbzaronhvyicvfszvr`) — aislados por RLS con el `salon_id` que viaja en el
JWT de cada barbero. El esquema (tablas, RLS, RPCs, triggers, Edge Function,
VAPID global) **ya está desplegado ahí**; no se aplica nada por cliente.

Dar de alta un cliente nuevo = **una sola llamada** a `provision_salon(...)` con
`execute_sql` (service_role). Crea el salón + categorías + servicios + horario +
usuario de login (con `salon_id` en `app_metadata`) + fila `barbers`.

```sql
select public.provision_salon(
  p_slug        => 'jordy-barber',
  p_name        => 'Jordy Barber',
  p_barber_name => 'Jordy Meza',
  p_login_email => 'jordy.barber@jordy-barber.local',  -- <usuario>@<slug>.local
  p_password    => 'la-contraseña',
  p_categories  => '[{"slug":"cortes","label":"Cortes","display_order":0}]'::jsonb,
  p_services    => '[
    {"slug":"sencillo","label":"Corte sencillo","category":"cortes","price_crc":4000,"duration_min":60,"display_order":0},
    {"slug":"sombreado","label":"Corte sombreado","category":"cortes","price_crc":5000,"duration_min":60,"display_order":1},
    {"slug":"lavado_cejas","label":"Corte + Lavado + Cejas","category":"cortes","price_crc":5500,"duration_min":60,"display_order":2},
    {"slug":"barba","label":"Corte + Barba","category":"cortes","price_crc":6000,"duration_min":60,"display_order":3},
    {"slug":"full","label":"Full service","category":"cortes","price_crc":7500,"duration_min":90,"display_order":4}
  ]'::jsonb,
  -- Horario por día (dow 0=Dom..6=Sáb); un día SIN fila = cerrado. open/close en minutos.
  p_hours       => '[
    {"dow":1,"open_min":480,"close_min":1140},{"dow":2,"open_min":480,"close_min":1140},
    {"dow":3,"open_min":480,"close_min":1140},{"dow":4,"open_min":480,"close_min":1140},
    {"dow":5,"open_min":480,"close_min":1140},{"dow":6,"open_min":480,"close_min":1140}
  ]'::jsonb,
  p_timezone              => 'America/Costa_Rica',
  -- `booking_horizon_days` es opcional (60 por defecto): hasta dónde puede
  -- agendar el cliente en el calendario del wizard.
  p_theme                 => '{"tagline":"Barbería","booking_horizon_days":60}'::jsonb,
  p_max_bookings_per_slot => 1,          -- barbería: 1 por espacio; salón: N
  p_notify_email          => 'correo@delcliente.com',
  p_resend_api_key         => null,       -- opcional (correo por Resend)
  p_notify_from            => null
);
```

Devuelve `{salon_id, barber_id, slug}`. Después solo hace falta desplegar la app
con `NEXT_PUBLIC_SALON_SLUG=<slug>` (ver `env.local.example`). La duración por
servicio (`duration_min`, múltiplos de 30) + `max_bookings_per_slot` cubren tanto
barberías (cortes de 60/90 min, 1 por espacio) como salones (30 min, N por espacio).

**Notas:**
- El precio `price_crc` en `null` se muestra como "Por cotizar".
- Los bloqueos por día completo que hace el barbero (vacaciones) son filas
  `appointments` con `kind='block'` — no hace falta nada extra en la base.
- Las categorías son por salón; podés tener una sola (`cortes`) o varias.
- Para editar precios/horario/servicios después: `update`/`insert` en
  `salon_services` / `salon_hours` de ese `salon_id`. **No requiere redeploy** —
  la app lee la config en vivo con `get_salon_public`.
- VAPID y la Edge Function `notify-booking` son **globales** (ya desplegadas). No
  se generan ni despliegan por cliente.

---

## Salón con VARIAS estilistas

`provision_salon` crea **una sola** estilista: la dueña, que es la única con login.
Para las demás:

```sql
-- 1. Marcar a la dueña como administradora del salón
update public.barbers set is_admin = true
where id = '<BARBER_ID que devolvió provision_salon>';

-- 2. Una llamada por cada estilista adicional
select public.add_salon_barber('<slug>', 'Camila Rojas',     2);
select public.add_salon_barber('<slug>', 'Nicole Fernández', 3);
```

Firma completa:

```
add_salon_barber(
  p_slug          text,
  p_name          text,
  p_display_order int     default 1,
  p_is_admin      boolean default false,
  p_login_email   text    default null,   -- solo si esta estilista va a entrar
  p_password      text    default null,
  p_notify_email  text    default null
) returns jsonb  -- {barber_id, salon_id, login_email}
```

**Por qué se crea un usuario para quien no inicia sesión:** `barbers.id` tiene FK a
`auth.users(id)`, así que toda estilista necesita un usuario. Las que no van a entrar
quedan como usuario "fantasma" con correo interno
(`stylist-<uuid>@<slug>.local`) y contraseña aleatoria que nunca se entrega.

**Qué gana la que tiene `is_admin`:** puede ver y gestionar las agendas de las demás
**de su salón** — crear, mover, borrar y bloquear. Las policies de `appointments` son
`salon_id = current_salon_id() and (barber_id = auth.uid() or is_salon_admin())`, así
que la frontera entre salones sigue intacta. En el dashboard le aparece un selector
de agenda con radio buttons.

**Limitación:** `salon_hours` es **por salón**, no por estilista. Todas comparten
apertura, cierre y almuerzo. Días libres fijos y vacaciones se modelan con bloqueos
de día completo.

### Catálogo por estilista (`barber_services`)

Por defecto **todas hacen de todo**: el catálogo es del salón. Si cada estilista tiene
lo suyo, se carga el mapeo en `barber_services` — y con eso la restricción se prende
sola para ese salón:

```sql
with pares(barbera, servicio) as (values
  ('Azucena Mora',    'peinado'),
  ('Azucena Mora',    'maquillaje'),
  ('Lineth Mora',     'corte-mujer'),
  ('Melissa Artavia', 'detox-capilar')
)
insert into public.barber_services (salon_id, barber_id, service_id)
select b.salon_id, b.id, v.id
from pares p
join public.barbers b        on b.name = p.barbera  and b.salon_id = '<SALON_ID>'
join public.salon_services v on v.slug = p.servicio and v.salon_id = '<SALON_ID>';
```

**Es opt-in y estricto.** Un salón **sin filas** se comporta como siempre. Uno **con
filas** las aplica a rajatabla: el wizard solo ofrece los servicios de la estilista
elegida, `book_appointment` rechaza el par que no exista, y el trigger
`enforce_booking_rules` lo vuelve a chequear — así también cae el
`update` directo del panel ("cambiar servicio"), que no pasa por el RPC.

**Cuidado:** con el modo prendido, una estilista **sin ninguna fila** queda sin
servicios y el wizard no deja reservarle. Al agregar una estilista a un salón que ya
usa `barber_services`, hay que cargarle sus servicios en la misma tanda.

El RPC `get_salon_public` expone `barbers[].service_slugs` y la bandera
`per_barber_services`. La bandera importa: sin ella, el `service_slugs` vacío de los
salones que no usan el modo se leería como "esta estilista no hace nada".

**Push:** se manda a las suscripciones del salón (`push_subscriptions.salon_id`), no
a las de la estilista de la cita — con varias estilistas la única suscrita es la
dueña. El aviso incluye el nombre de la estilista.

**Correo:** sigue yendo a `barbers.notify_email` de la estilista de la cita. Si solo
la dueña tiene casilla, las reservas de las demás no mandan correo (el push sí).

## Almuerzo / descanso

`provision_salon` **no carga** el descanso (solo lee `dow`, `open_min`, `close_min`
del jsonb). Si el salón cierra a almorzar, hay que ponerlo aparte:

```sql
update public.salon_hours set break_start_min = 720, break_end_min = 780  -- 12:00–13:00
where salon_id = '<SALON_ID>' and dow between 1 and 5;
```

`book_appointment` rechaza cualquier servicio que invada esa franja, y el wizard ya
no ofrece esos espacios. Con servicios largos (3–4 h) el almuerzo recorta mucho la
disponibilidad: revisá que queden huecos utilizables antes de cerrar el horario.

**`last_start_min` en NULL** cuando haya servicios de más de 90 min. Si se define, la
base deja de exigir que el servicio termine antes del cierre y solo mira la hora de
inicio.

## Servicios que van por teléfono (`theme.call_to_book`)

Para los tratamientos que el salón NO quiere que se reserven solos (los muy largos,
los que dependen del estado del cabello) hay un aviso en el wizard: sale al entrar al
paso "¿Qué servicio querés?", los lista, y se cierra con **Aceptar**. Se muestra una
vez por reserva.

Estos servicios **no van en `salon_services`** — no son reservables, así que no
necesitan duración real, estilista ni cupo. Viven en el `theme` del salón:

```sql
update public.salons
set theme = theme || jsonb_build_object(
  'phone', '+506 8888-8888',           -- opcional: botón "Llamar al salón"
  'call_to_book', jsonb_build_array(
    jsonb_build_object('label', 'Balayage',            'duration_min', 240),
    jsonb_build_object('label', 'Corrección de color', 'duration_min', 300)
  )
)
where slug = '<slug>';
```

- `duration_min` es solo para mostrar (`180` → "3 horas", `150` → "2:30 h"). Se puede
  omitir y el aviso muestra solo el nombre.
- **`call_to_book` vacío o ausente = no se muestra ningún aviso.**
- Sin `phone`, el aviso sale sin botón de llamada.
- Como todo el `theme`, se edita en vivo: **no requiere redeploy**.

Es lo que resuelve el caso de un servicio que no cabe en la agenda. Ejemplo real: con
un horario de 8:00–17:00 y almuerzo de 12:00 a 13:00, la mañana y la tarde son bloques
de 4 h, así que un servicio de **5 h no tiene ningún espacio válido entre semana** —
`generateDaySlots` devolvería la lista vacía y la clienta vería un día sin horarios sin
entender por qué. Mejor no ofrecerlo y decirle que llame.

### Candado de horario del servidor (`salons.enforce_hours`)

`book_appointment` siempre valida horario, descanso y cierre. Pero el panel de la
estilista escribe **directo** a `appointments` en dos casos (reagendar y cambiar
servicio), y ahí el RPC no participa: cambiar una cita de 30 min por una de 90 puede
empujarla dentro del almuerzo. `salons.enforce_hours` mueve esa validación al trigger
`enforce_booking_rules`, que sí ven los tres caminos.

```sql
update public.salons set enforce_hours = true where slug = '<slug>';
```

**Apagado por defecto, y a propósito.** Un salón que cambió su horario después de
haber agendado tiene citas viejas que ya no caen dentro del horario nuevo; prenderlo
de golpe deja esas filas sin poder editarse. Antes de prenderlo conviene revisar que
no haya ninguna:

```sql
select a.id, (a.start_time at time zone s.timezone) as inicio
from public.appointments a
join public.salons s on s.id = a.salon_id
left join public.salon_hours h on h.salon_id = a.salon_id
     and h.dow = extract(dow from (a.start_time at time zone s.timezone))
where s.slug = '<slug>' and a.kind = 'booking' and a.start_time > now()
  and (h.open_min is null
       or (extract(hour from (a.start_time at time zone s.timezone)) * 60
           + extract(minute from (a.start_time at time zone s.timezone))) < h.open_min);
```

Los bloqueos (`kind='block'`) quedan exentos: arrancan a las 00:00, fuera del horario
por definición. Y el trigger solo revalida cuando la cita **cambia** de horario,
servicio o estilista, para que corregir un nombre o un teléfono nunca falle.
