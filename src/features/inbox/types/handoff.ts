// Shared handoff constants. Kept dependency-free on purpose: the settings UI is
// a client component, so it must not pull in handoff-notifier.ts (which imports
// the service-role Supabase client and the YCloud dispatcher).

/** Sent to the contact when a workspace has not customised the acknowledgement. */
export const DEFAULT_HANDOFF_ACK =
  "Gracias por escribir. En un momento te atiende un asesor.";
