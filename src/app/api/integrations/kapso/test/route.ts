import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { listAllPhoneNumbers } from "@/features/inbox/services/kapso-client";

// Workspace-agnostic Kapso key tester. Used during onboarding (before a
// workspace exists) so the API key is never exposed to the browser and the
// call is not CORS-blocked. Auth-gated: any signed-in user may validate a key.
//
// Kapso has no /balance equivalent to YCloud's. Instead we list the project's
// WhatsApp numbers, which both proves the key works and returns the
// phone_number_id + waba_id the caller would otherwise have to copy by hand.

const bodySchema = z.object({
  apiKey: z.string().min(1, "API key requerida"),
});

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  try {
    const numbers = await listAllPhoneNumbers(parsed.data.apiKey);

    if (numbers.length === 0) {
      return NextResponse.json({
        ok: false,
        error:
          "La API key funciona, pero no hay ningún número de WhatsApp en el proyecto de Kapso",
      });
    }

    // Real numbers first — a sandbox entry can't receive from the outside world.
    const sorted = [...numbers].sort((a, b) => {
      const rank = (n: (typeof numbers)[number]) =>
        n.kind === "production" && n.status === "CONNECTED" ? 0 : 1;
      return rank(a) - rank(b);
    });

    return NextResponse.json({ ok: true, phoneNumbers: sorted });
  } catch (err) {
    console.error(
      "[integrations/kapso/test] Kapso fetch error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({
      ok: false,
      error: "API Key inválida o sin acceso",
    });
  }
}
