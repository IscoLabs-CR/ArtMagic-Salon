import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSalonConfig } from "@/lib/salon";
import Dashboard from "./Dashboard";

export const dynamic = "force-dynamic";

export default async function BarberoPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/barbero/login");

  // Todas las estilistas activas del salón (la policy `barbers_tenant_read` ya
  // limita la lectura al salón del JWT). Quien tenga `is_admin` puede cambiar de
  // agenda con el selector; el resto solo ve la propia.
  const { data: barbers, error: barbersError } = await supabase
    .from("barbers")
    .select("id, name, is_admin, display_order")
    .eq("active", true)
    .order("display_order");
  if (barbersError) {
    console.error("No se pudo cargar el equipo del salón:", barbersError.message);
  }

  const me = (barbers ?? []).find((b) => b.id === user.id);

  const config = await getSalonConfig();

  return (
    <Dashboard
      config={config}
      barberId={user.id}
      barberName={me?.name ?? "Estilista"}
      isAdmin={me?.is_admin ?? false}
      barbers={(barbers ?? []).map((b) => ({ id: b.id, name: b.name }))}
    />
  );
}
