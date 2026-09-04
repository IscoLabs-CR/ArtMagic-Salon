import { getSalonConfig } from "@/lib/salon";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const config = await getSalonConfig();
  return <LoginForm salonName={config.name} slug={config.slug} />;
}
