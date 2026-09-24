// Shared timezone default. Kept dependency-free on purpose: the settings UI is
// a client component, so it must not pull in business-info.ts (which imports
// the service-role Supabase client).

/** IANA timezone used when a workspace has not configured a valid one. */
export const DEFAULT_TIMEZONE = "America/Mexico_City";
