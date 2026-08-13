import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

type YCloudCredentials = {
  ycloud_api_key?: string;
};

type YCloudBalanceResponse = {
  balance?: number;
  currency?: string;
  [key: string]: unknown;
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data } = await svc
    .from("integrations")
    .select("credentials, enabled")
    .eq("workspace_id", workspaceId)
    .eq("provider", "ycloud")
    .single();

  const creds = (await decryptCredentials(
    data?.credentials as Record<string, unknown> | null,
    workspaceId,
    "ycloud",
  )) as YCloudCredentials;
  const apiKey = creds.ycloud_api_key;

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "No API key configured" });
  }

  try {
    const res = await fetch("https://api.ycloud.com/v2/balance", {
      headers: { "X-API-Key": apiKey },
    });

    if (res.ok) {
      const balance = (await res.json()) as YCloudBalanceResponse;
      return NextResponse.json({ ok: true, balance });
    }

    return NextResponse.json({
      ok: false,
      error: `YCloud returned ${res.status}`,
    });
  } catch (err) {
    console.error(
      "[integrations/test] YCloud fetch error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({ ok: false, error: "Failed to reach YCloud" });
  }
}
