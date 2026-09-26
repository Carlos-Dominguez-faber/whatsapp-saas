/**
 * highlevel-client.ts — HighLevel (LeadConnector) API client.
 *
 * Auth: Private Integration Token (PIT). The workspace stores its PIT in
 * integrations.credentials.highlevel_pit and its Location/Calendar ids in
 * integrations.config. No OAuth, no token refresh — the PIT is long-lived.
 *
 * API v2 docs: https://highlevel.stoplight.io/docs/integrations
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { decryptCredentials } from "@/shared/lib/integration-secrets";
import { DEFAULT_COUNTRY_CODE, normalizePhone, phoneVariants } from "./phone";

const HL_BASE_URL = "https://services.leadconnectorhq.com";
const HL_API_VERSION = "2021-07-28";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface HLConfig {
  /** Private Integration Token. */
  token: string;
  locationId: string;
  /** Default calendar for bookings; null when not configured. */
  calendarId: string | null;
  /** Pipeline for setter-created opportunities; null when not configured. */
  pipelineId: string | null;
  /** Stage within the pipeline for new opportunities; null when not configured. */
  pipelineStageId: string | null;
  /**
   * IANA timezone for availability queries when the model does not pass a
   * valid one. Defaults to "UTC".
   */
  timezone: string;
}

export interface HLPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

export interface HLContact {
  id: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  tags?: string[];
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  tags: string[] | null;
  hl_contact_id: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function hlHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Version: HL_API_VERSION,
    "Content-Type": "application/json",
  };
}

function splitName(fullName: string | null): {
  firstName: string;
  lastName: string;
} {
  if (!fullName) return { firstName: "", lastName: "" };
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

/**
 * Loads the workspace's HighLevel PIT + Location/Calendar ids.
 * Returns null when HighLevel is not connected (no PIT or no location).
 */
export async function getHLConfig(
  workspaceId: string,
): Promise<HLConfig | null> {
  const supabase = svc();
  const { data, error } = await supabase
    .from("integrations")
    .select("credentials, config, enabled")
    .eq("workspace_id", workspaceId)
    .eq("provider", "highlevel")
    .eq("enabled", true)
    .maybeSingle();

  if (error || !data) return null;

  const creds = await decryptCredentials(
    data.credentials as Record<string, unknown> | null,
    workspaceId,
    "highlevel",
  );
  const config = (data.config as Record<string, unknown> | null) ?? {};

  const token = creds.highlevel_pit;
  const locationId = config.location_id;
  const calendarId = config.calendar_id;
  const pipelineId = config.pipeline_id;
  const pipelineStageId = config.pipeline_stage_id;

  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof locationId !== "string" || locationId.length === 0) return null;

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  return {
    token,
    locationId,
    calendarId: str(calendarId),
    pipelineId: str(pipelineId),
    pipelineStageId: str(pipelineStageId),
    timezone: str(config.timezone) ?? "UTC",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Contacts
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Upserts a contact in HighLevel by phone (LeadConnector dedup handles matching)
 * and returns its HL contact id. Used by the booking tool so an appointment can
 * be created even when the contact was never synced before.
 */
export async function upsertHLContactByPhone(
  cfg: HLConfig,
  contact: { name?: string | null; phone: string; email?: string | null },
): Promise<string | null> {
  const { firstName, lastName } = splitName(contact.name ?? null);

  const payload: Record<string, unknown> = {
    locationId: cfg.locationId,
    phone: contact.phone,
    ...(firstName && { firstName }),
    ...(lastName && { lastName }),
    ...(contact.email && { email: contact.email }),
  };

  try {
    const res = await fetch(`${HL_BASE_URL}/contacts/upsert`, {
      method: "POST",
      headers: hlHeaders(cfg.token),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(
        "[HL] upsertHLContactByPhone failed:",
        res.status,
        (await res.text()).slice(0, 200),
      );
      return null;
    }
    const json = (await res.json()) as {
      contact?: { id?: string };
      id?: string;
    };
    return json.contact?.id ?? json.id ?? null;
  } catch (err) {
    console.error("[HL] upsertHLContactByPhone error:", err);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// syncContactToHL — push local contact to HighLevel
// ──────────────────────────────────────────────────────────────────────────────
export async function syncContactToHL(
  workspaceId: string,
  contactId: string,
): Promise<{ hl_id: string } | null> {
  const cfg = await getHLConfig(workspaceId);
  if (!cfg) {
    console.warn("[HL] syncContactToHL: not connected for", workspaceId);
    return null;
  }

  const supabase = svc();

  const { data: contactData, error: contactError } = await supabase
    .from("contacts")
    .select("id, name, phone, email, tags, hl_contact_id")
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .single();

  if (contactError || !contactData) {
    console.error(
      "[HL] syncContactToHL: contact not found:",
      contactError?.message,
    );
    return null;
  }

  const contact = contactData as ContactRow;
  const { firstName, lastName } = splitName(contact.name);

  // Create (with locationId) or update by hl_contact_id. Tags always go, even
  // an empty list: HighLevel→local syncs merge tags, so a tag removed here
  // and left there would come back.
  const basePayload: Record<string, unknown> = {
    phone: contact.phone,
    ...(firstName && { firstName }),
    ...(lastName && { lastName }),
    ...(contact.email && { email: contact.email }),
    tags: contact.tags ?? [],
  };

  let hlId: string;

  try {
    if (contact.hl_contact_id) {
      const res = await fetch(
        `${HL_BASE_URL}/contacts/${contact.hl_contact_id}`,
        {
          method: "PUT",
          headers: hlHeaders(cfg.token),
          body: JSON.stringify(basePayload),
        },
      );
      if (!res.ok) {
        throw new Error(
          `HL PUT /contacts/${contact.hl_contact_id} ${res.status}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as {
        contact?: { id: string };
        id?: string;
      };
      hlId = json.contact?.id ?? json.id ?? contact.hl_contact_id;
    } else {
      const res = await fetch(`${HL_BASE_URL}/contacts/upsert`, {
        method: "POST",
        headers: hlHeaders(cfg.token),
        body: JSON.stringify({ ...basePayload, locationId: cfg.locationId }),
      });
      if (!res.ok) {
        throw new Error(
          `HL POST /contacts/upsert ${res.status}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as {
        contact?: { id: string };
        id?: string;
      };
      hlId = json.contact?.id ?? json.id ?? "";
      if (!hlId) throw new Error("HL upsert returned no contact id");
    }
  } catch (err) {
    console.error("[HL] syncContactToHL error:", err);
    return null;
  }

  await linkHLContact(supabase, workspaceId, contactId, hlId);

  return { hl_id: hlId };
}

/**
 * Saves the HighLevel id on a local contact. A unique index allows one local
 * contact per HighLevel contact, so a second one claiming the same id fails
 * with 23505: two local records for one person (e.g. the same number stored
 * two ways). They are never merged automatically — the contact that holds the
 * id is named in an event and in the log, for the team to decide.
 */
export async function linkHLContact(
  supabase: ReturnType<typeof svc>,
  workspaceId: string,
  contactId: string,
  hlContactId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("contacts")
    .update({ hl_contact_id: hlContactId, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("workspace_id", workspaceId);
  if (!error) return true;

  if (error.code === "23505") {
    const { data: holder } = await supabase
      .from("contacts")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("hl_contact_id", hlContactId)
      .limit(1);
    const heldBy = (holder as Array<{ id: string }> | null)?.[0]?.id ?? null;
    console.warn("[HL] HighLevel contact already linked to another local contact", {
      contactId,
      heldBy,
    });
    await supabase
      .from("events")
      .insert({
        type: "hl_contact_link_conflict",
        level: "warn",
        workspace_id: workspaceId,
        payload: { contact_id: contactId, hl_contact_id: hlContactId, held_by: heldBy },
      })
      .then(
        () => {},
        () => {},
      );
    return false;
  }

  console.error("[HL] Failed to save hl_contact_id:", error.message);
  return false;
}

/** The workspace's country code for numbers written without one. */
async function workspaceCountryCode(
  supabase: ReturnType<typeof svc>,
  workspaceId: string,
): Promise<string> {
  const { data } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const code = (data?.structured as { default_country_code?: unknown } | null)
    ?.default_country_code;
  return typeof code === "string" && /^\d{1,4}$/.test(code) ? code : DEFAULT_COUNTRY_CODE;
}

// ──────────────────────────────────────────────────────────────────────────────
// syncContactFromHL — pull HL contact into our DB
// ──────────────────────────────────────────────────────────────────────────────
export async function syncContactFromHL(
  workspaceId: string,
  hlContactId: string,
): Promise<void> {
  const cfg = await getHLConfig(workspaceId);
  if (!cfg) {
    console.warn("[HL] syncContactFromHL: not connected for", workspaceId);
    return;
  }

  let hlContact: HLContact;
  try {
    const res = await fetch(`${HL_BASE_URL}/contacts/${hlContactId}`, {
      headers: hlHeaders(cfg.token),
    });
    if (!res.ok) {
      throw new Error(
        `HL GET /contacts/${hlContactId} ${res.status}: ${await res.text()}`,
      );
    }
    const json = (await res.json()) as { contact?: HLContact } | HLContact;
    hlContact =
      "contact" in json && json.contact ? json.contact : (json as HLContact);
  } catch (err) {
    console.error("[HL] syncContactFromHL fetch error:", err);
    return;
  }

  if (!hlContact.phone) {
    console.warn("[HL] syncContactFromHL: HL contact has no phone, skipping");
    return;
  }

  const supabase = svc();
  // Local contacts are stored in E.164 (normalizer.ts). HighLevel's number may
  // come local ("998 123 4567", completed with the workspace's country code)
  // or as the other form of a Mexican/Argentinian mobile (+52 vs +52 1): the
  // lookup tries every form the same line can be stored in.
  const countryCode = await workspaceCountryCode(supabase, workspaceId);
  const phone = normalizePhone(hlContact.phone, countryCode);
  const fullName =
    [hlContact.firstName, hlContact.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || null;
  const hlTags = Array.isArray(hlContact.tags) ? hlContact.tags : [];

  // The contact already linked to this HighLevel id, else the one with this
  // phone (typically created by WhatsApp before HighLevel knew about it).
  type LocalContact = {
    id: string;
    name: string | null;
    email: string | null;
    tags: unknown;
    hl_contact_id: string | null;
  };
  const byHlId = await supabase
    .from("contacts")
    .select("id, name, email, tags, hl_contact_id")
    .eq("workspace_id", workspaceId)
    .eq("hl_contact_id", hlContactId)
    .limit(1);
  if (byHlId.error) {
    console.error("[HL] syncContactFromHL lookup error:", byHlId.error.message);
    return;
  }
  let existing = ((byHlId.data ?? []) as LocalContact[])[0] ?? null;
  if (!existing) {
    const byPhone = await supabase
      .from("contacts")
      .select("id, name, email, tags, hl_contact_id")
      .eq("workspace_id", workspaceId)
      .in("phone", phoneVariants(hlContact.phone, countryCode));
    if (byPhone.error) {
      console.error("[HL] syncContactFromHL lookup error:", byPhone.error.message);
      return;
    }
    const matches = (byPhone.data ?? []) as LocalContact[];
    // Prefer a contact not linked to anyone yet.
    existing = matches.find((c) => !c.hl_contact_id) ?? matches[0] ?? null;
  }

  if (existing?.hl_contact_id && existing.hl_contact_id !== hlContactId) {
    // This phone belongs to a contact linked to ANOTHER HighLevel contact:
    // leave both alone rather than steal the link.
    console.warn("[HL] syncContactFromHL: phone already linked to another HL contact");
    return;
  }

  if (existing) {
    // Nothing local is overwritten: tags are merged (auto-tagging and the
    // setter's tags survive), name and email are filled only when empty, and
    // the local phone stays — it is the conversation's WhatsApp identity.
    const localTags = Array.isArray(existing.tags) ? (existing.tags as string[]) : [];
    const { error } = await supabase
      .from("contacts")
      .update({
        ...(!existing.name?.trim() && fullName !== null && { name: fullName }),
        ...(!existing.email?.trim() && hlContact.email && { email: hlContact.email }),
        tags: Array.from(new Set([...localTags, ...hlTags])),
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("workspace_id", workspaceId);
    if (error) {
      console.error("[HL] syncContactFromHL update error:", error.message);
      return;
    }
    if (existing.hl_contact_id !== hlContactId) {
      await linkHLContact(supabase, workspaceId, existing.id, hlContactId);
    }
    return;
  }

  const { error } = await supabase.from("contacts").insert({
    workspace_id: workspaceId,
    hl_contact_id: hlContactId,
    phone,
    ...(fullName !== null && { name: fullName }),
    ...(hlContact.email && { email: hlContact.email }),
    tags: hlTags,
  });
  if (error) {
    // 23505: a concurrent sync or inbound message created it first.
    console.error("[HL] syncContactFromHL insert error:", error.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Opportunities (Pipelines)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Lists the workspace's HighLevel pipelines with their stages. Used by the
 * integrations UI to populate the pipeline/stage selectors for the setter's
 * create_hl_opportunity action. Returns null when HL is not connected or the
 * API call fails.
 */
export async function listHLPipelines(
  workspaceId: string,
): Promise<HLPipeline[] | null> {
  const cfg = await getHLConfig(workspaceId);
  if (!cfg) return null;

  try {
    const res = await fetch(
      `${HL_BASE_URL}/opportunities/pipelines?locationId=${encodeURIComponent(cfg.locationId)}`,
      { headers: hlHeaders(cfg.token) },
    );
    if (!res.ok) {
      console.error(
        "[HL] listHLPipelines failed:",
        res.status,
        (await res.text()).slice(0, 200),
      );
      return null;
    }
    const json = (await res.json()) as {
      pipelines?: Array<{
        id: string;
        name: string;
        stages?: Array<{ id: string; name: string }>;
      }>;
    };
    return (json.pipelines ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      stages: (p.stages ?? []).map((s) => ({ id: s.id, name: s.name })),
    }));
  } catch (err) {
    console.error("[HL] listHLPipelines error:", err);
    return null;
  }
}

/**
 * Creates an opportunity in HighLevel for a local contact, in the workspace's
 * configured pipeline/stage. Resolves the HL contact id (reusing hl_contact_id
 * when present, otherwise upserting by phone). Returns the new opportunity id,
 * or null when HL is not connected, the pipeline/stage is unconfigured, the
 * contact can't be resolved, or the API call fails. Never throws.
 */
export async function createHLOpportunity(
  workspaceId: string,
  contactId: string,
  opts?: { name?: string; monetaryValue?: number },
): Promise<{ id: string } | null> {
  const cfg = await getHLConfig(workspaceId);
  if (!cfg) {
    console.warn("[HL] createHLOpportunity: not connected for", workspaceId);
    return null;
  }
  if (!cfg.pipelineId || !cfg.pipelineStageId) {
    console.warn(
      "[HL] createHLOpportunity: pipeline/stage not configured for",
      workspaceId,
    );
    return null;
  }

  const supabase = svc();

  const { data: contactData, error: contactError } = await supabase
    .from("contacts")
    .select("id, name, phone, email, hl_contact_id")
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .single();

  if (contactError || !contactData) {
    console.error(
      "[HL] createHLOpportunity: contact not found:",
      contactError?.message,
    );
    return null;
  }

  const contact = contactData as Pick<
    ContactRow,
    "id" | "name" | "phone" | "email" | "hl_contact_id"
  >;

  // Resolve the HL contact id: reuse if already synced, otherwise upsert by
  // phone (and persist it so future syncs find it).
  let hlContactId = contact.hl_contact_id;
  if (!hlContactId) {
    hlContactId = await upsertHLContactByPhone(cfg, {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
    });
    if (hlContactId) {
      await linkHLContact(supabase, workspaceId, contactId, hlContactId);
    }
  }
  if (!hlContactId) {
    console.error("[HL] createHLOpportunity: could not resolve HL contact id");
    return null;
  }

  const name = opts?.name?.trim() || contact.name || contact.phone;

  const payload: Record<string, unknown> = {
    pipelineId: cfg.pipelineId,
    locationId: cfg.locationId,
    pipelineStageId: cfg.pipelineStageId,
    contactId: hlContactId,
    name,
    status: "open",
    ...(typeof opts?.monetaryValue === "number" && {
      monetaryValue: opts.monetaryValue,
    }),
  };

  try {
    const res = await fetch(`${HL_BASE_URL}/opportunities/`, {
      method: "POST",
      headers: hlHeaders(cfg.token),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(
        "[HL] createHLOpportunity failed:",
        res.status,
        (await res.text()).slice(0, 200),
      );
      return null;
    }
    const json = (await res.json()) as {
      opportunity?: { id?: string };
      id?: string;
    };
    const id = json.opportunity?.id ?? json.id ?? null;
    return id ? { id } : null;
  } catch (err) {
    console.error("[HL] createHLOpportunity error:", err);
    return null;
  }
}
