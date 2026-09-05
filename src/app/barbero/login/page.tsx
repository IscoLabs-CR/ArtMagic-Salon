import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSalonConfig } from "@/lib/salon";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Si la sesión del dispositivo sigue viva, no se vuelve a pedir la clave.
  // También rescata el caso en que un fallo momentáneo de red rebotó a la
  // estilista al login con la sesión intacta: vuelve a entrar sola.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/barbero");

  const config = await getSalonConfig();
  return <LoginForm salonName={config.name} slug={config.slug} />;
}
