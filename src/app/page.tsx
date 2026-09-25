import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/features/workspace/services/active-workspace";

// Role-aware landing. Staff (admin/manager) go to the inbox as before.
// Anyone else — namely a "viewer"/"agent" client-tester account created
// just so a prospective client can try their agent — goes to the isolated,
// config-free /probar screen instead. Unauthenticated visitors fall through
// to /inbox, which itself redirects to /login.
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const membership = await getActiveWorkspace(supabase, user.id);
    if (membership && !["admin", "manager"].includes(membership.role)) {
      redirect("/probar");
    }
  }

  redirect("/inbox");
}
