import Link from "next/link";
import { getSalonConfig } from "@/lib/salon";
import { weeklyHoursLabel } from "@/lib/booking";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = await getSalonConfig();
  const tagline =
    typeof config.theme.tagline === "string" ? config.theme.tagline : null;
  // Subtítulo "con {estilista}" solo cuando hay una única profesional.
  const soloBarber = config.barbers.length === 1 ? config.barbers[0].name : null;
  const hours = weeklyHoursLabel(config);

  return (
    <main className="relative flex-1 grid place-items-center overflow-hidden px-5 pb-[calc(2.5rem_+_env(safe-area-inset-bottom))] pt-[calc(2.5rem_+_env(safe-area-inset-top))]">
      {/* Fondo de la marca (Background.jpeg) */}
      <div className="brand-bg pointer-events-none fixed inset-0 -z-10" aria-hidden />
      <div className="w-full max-w-xl">
        {/* Vidrio gris, no papel blanco: el blanco puro dejaba la placa negra
            del logo como un recorte duro en medio del card. Sobre este gris el
            texto secundario pierde contraste, así que aquí va en `ink/75` y
            `brand-ink` en vez de `muted` y `gold-deep` (todo ≥ 5:1). */}
        <div className="relative overflow-hidden rounded-[2rem] bg-paper-smoke/80 shadow-[0_30px_90px_-40px_rgba(0,0,0,0.85)] ring-1 ring-gold/30 backdrop-blur-3xl">
          {/* Acceso del equipo. Va DENTRO del card, en su esquina: en celular el
              card ocupa casi todo el ancho, así que flotarlo sobre la página lo
              dejaría montado sobre el borde redondeado. Apagado y lejos del botón
              de reservar, para que ningún cliente lo toque por error. */}
          <Link
            href="/barbero/login"
            aria-label="Acceso estilistas"
            title="Acceso estilistas"
            className="absolute right-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full text-ink/60 transition-colors hover:bg-brand-tint hover:text-brand sm:right-5 sm:top-5"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <path d="m10 17 5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
          </Link>
          <div className="px-8 py-12 text-center sm:px-14 sm:py-16">
            {/* Logo del salón (PNG con fondo transparente) sobre placa negra */}
            <div className="mx-auto mb-7 grid h-36 w-36 place-items-center overflow-hidden rounded-3xl bg-gradient-to-b from-[#2b241d] to-[#0f0d0b] shadow-[0_16px_40px_-18px_rgba(0,0,0,0.7)] ring-1 ring-gold/40 sm:h-40 sm:w-40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo.png"
                alt={config.name}
                className="h-full w-full object-contain"
              />
            </div>

            {tagline && (
              <p className="font-display text-xs uppercase tracking-[0.4em] text-brand-ink">
                {tagline}
              </p>
            )}

            {/* `anywhere` es solo una red: parte una palabra que no quepa en vez
                de desbordar el card. El tamaño no cambia. */}
            <h1 className="mt-3 font-fancy text-6xl font-bold uppercase leading-[1] tracking-tight text-ink [overflow-wrap:anywhere] sm:text-7xl">
              {config.name}
            </h1>

            {soloBarber && (
              <p className="mt-2 font-fancy text-xl italic tracking-wide text-brand-ink">
                con {soloBarber}
              </p>
            )}

            <p className="mx-auto mt-5 max-w-sm text-balance text-ink/75">
              Reservá tu cita en segundos — elegí día y servicio, sin crear cuenta
              y sin filas.
            </p>

            {/* Un solo llamado a la acción: el cliente no puede equivocarse de
                botón. El acceso del equipo vive en la esquina del card. */}
            <div className="mx-auto mt-9 max-w-xs">
              <Link
                href="/reservar"
                className="inline-flex w-full items-center justify-center rounded-full bg-brand px-6 py-4 font-fancy text-lg font-bold uppercase tracking-wide text-white transition-colors hover:bg-brand-deep"
              >
                Reservar cita
              </Link>
            </div>

            <p className="mt-9 text-xs uppercase leading-relaxed tracking-[0.25em] text-ink/75">
              {hours.map((line, i) => (
                <span key={i}>
                  {line}
                  {i < hours.length - 1 && <br />}
                </span>
              ))}
            </p>
          </div>
        </div>

        <footer className="mt-6 text-center text-[11px] leading-relaxed text-cream/70 select-none">
          <p className="font-display uppercase tracking-[0.25em]">Isco Labs · 2026</p>
          <p className="mt-0.5 tracking-wide">
            Contacto:{" "}
            <a
              href="mailto:iscolabscr@gmail.com"
              className="transition-colors hover:text-gold"
            >
              iscolabscr@gmail.com
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
