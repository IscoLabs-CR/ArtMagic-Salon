import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Deno edge function, not part of the Next.js app / TS project.
    "supabase/**",
    // Scripts de build (CommonJS de Node y PowerShell): generan el logo y los
    // iconos, no forman parte del bundle ni del proyecto TS.
    "scripts/**",
  ]),
]);

export default eslintConfig;
