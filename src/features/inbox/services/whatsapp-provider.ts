// The WhatsApp provider this branch ships with: `main` is YCloud and the
// provider/kapso branch sets these to Kapso. Provider-neutral code that still
// has to find the WhatsApp integration row (Jev keeps its settings in it)
// reads the provider from here instead of a literal, so `git merge main` into
// the provider branch neither conflicts nor silently targets the wrong row.
export const WHATSAPP_PROVIDER = "kapso" as const;
export const WHATSAPP_PROVIDER_LABEL = "Kapso";
