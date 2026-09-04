export type AppointmentKind = "booking" | "block";

export interface Appointment {
  id: string;
  barber_id: string;
  start_time: string;
  end_time: string;
  service_slug: string | null; // slug del catálogo salon_services (dinámico)
  kind: AppointmentKind;
  client_name: string | null;
  client_phone: string | null;
  created_at: string;
}
