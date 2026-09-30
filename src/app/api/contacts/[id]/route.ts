/**
 * PATCH /api/contacts/[id]
 * Update a contact's CRM fields. Auth via user session + RLS.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { applyContactUpdate } from "@/features/inbox/services/contact-update";

const PatchContactSchema = z.object({
  name: z.string().min(1, "El nombre no puede estar vacío").optional(),
  email: z.string().email("Email inválido").optional(),
  stage: z.enum(["new", "engaged", "qualified", "customer", "lost"]).optional(),
  tags: z.array(z.string()).optional(),
  opt_in: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  // 1. Auth
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  // 2. Resolve route param
  const { id: contactId } = await params;

  if (!contactId) {
    return NextResponse.json(
      { error: "Contact id requerido" },
      { status: 400 },
    );
  }

  // 3. Validate body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = PatchContactSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 422 },
    );
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "No se proporcionaron campos a actualizar" },
      { status: 400 },
    );
  }

  // 4. Update (RLS enforces workspace ownership; the opt-in only changes when
  //    it differs from the stored one, and reopening an opt-out takes a manager)
  const result = await applyContactUpdate(supabase, contactId, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true, contact: result.contact });
}
