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

  // Create (with locationId) or update by hl_contact_id.
  const basePayload: Record<string, unknown> = {
    phone: contact.phone,
    ...(firstName && { firstName }),
    ...(lastName && { lastName }),
    ...(contact.email && { email: contact.email }),
    ...(contact.tags && contact.tags.length > 0 && { tags: contact.tags }),
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

  const { error: updateError } = await supabase
    .from("contacts")
    .update({ hl_contact_id: hlId, updated_at: new Date().toISOString() })
    .eq("id", contactId);

  if (updateError) {
    console.error("[HL] Failed to save hl_contact_id:", updateError.message);
  }

  return { hl_id: hlId };
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

  const supabase = svc();

  const fullName =
    [hlContact.firstName, hlContact.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || null;

  if (!hlContact.phone) {
    console.warn("[HL] syncContactFromHL: HL contact has no phone, skipping");
    return;
  }

  const { error } = await supabase.from("contacts").upsert(
    {
      workspace_id: workspaceId,
      hl_contact_id: hlContactId,
      phone: hlContact.phone,
      ...(fullName !== null && { name: fullName }),
      ...(hlContact.email && { email: hlContact.email }),
      ...(hlContact.tags && { tags: hlContact.tags }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,hl_contact_id", ignoreDuplicates: false },
  );

  if (error) {
    console.error("[HL] syncContactFromHL upsert error:", error.message);
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
      await supabase
        .from("contacts")
        .update({
          hl_contact_id: hlContactId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", contactId);
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
