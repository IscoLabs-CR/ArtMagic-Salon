import { getSalonConfig } from "@/lib/salon";
import Wizard from "./Wizard";

export const dynamic = "force-dynamic";

export default async function ReservarPage() {
  // Config del salón (nombre, barberos, servicios, horario) desde la base.
  const config = await getSalonConfig();

  return (
    <>
      {/* Mismo fondo de marca que la página de inicio */}
      <div className="brand-bg fixed inset-0 -z-10" aria-hidden />
      <Wizard config={config} />
    </>
  );
}
