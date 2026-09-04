import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: "#ffffff",
          // Vidrio gris cálido: el card de la landing. El blanco puro chocaba
          // con la placa negra del logo; este gris hace de puente entre los dos.
          smoke: "#d9d3c9",
        },
        // Negro cálido del logo, no un gris azulado: el resto de la paleta es
        // dorada y un ink frío la ensucia.
        ink: "#171310",
        muted: "#6d6459",
        line: "#e8e1d4",
        // Texto sobre el fondo oscuro de la marca (landing, wizard, login).
        cream: "#f6efe2",
        // Dorado antiguo: es el color interactivo (botones, estado activo,
        // enlaces). Oscurecido hasta 5:1 sobre blanco — el dorado brillante del
        // logo no llega a AA como texto ni como fondo de texto blanco.
        brand: {
          DEFAULT: "#8a6a1f",
          deep: "#5e4712",
          tint: "#faf3e3",
          // Dorado casi negro: el acento de texto sobre `paper-smoke`, donde
          // `deep` se queda en 4.4:1 y no llega a AA.
          ink: "#4a3a0f",
        },
        // Dorado brillante del logo: decorativo (aros, filetes) y marca los
        // bloqueos en la agenda. `deep` tiene contraste AA sobre `tint`.
        gold: {
          DEFAULT: "#c8a24c",
          deep: "#7a5c1f",
          tint: "#fdf6e6",
        },
      },
      spacing: {
        // Zonas seguras del teléfono: el notch/barra de estado arriba y la barra
        // de gestos abajo. Solo traen valor con `viewport-fit=cover` (ver el
        // `viewport` de `layout.tsx`); en escritorio valen 0 y no estorban.
        "safe-top": "env(safe-area-inset-top)",
        "safe-bottom": "env(safe-area-inset-bottom)",
      },
      fontFamily: {
        display: ["var(--font-oswald)", "sans-serif"],
        // Serif de alto contraste para el nombre del salón — acompaña al
        // logotipo sin competir con él.
        fancy: ["var(--font-fancy)", "Georgia", "serif"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono-ticket)", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
