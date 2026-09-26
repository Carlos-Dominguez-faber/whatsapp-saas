import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OnboardingWizard } from "@/features/onboarding/components/onboarding-wizard";

export default async function OnboardingPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // If user already has an active membership, skip onboarding
  const { data: membership } = await supabase
    .from("memberships")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (membership) redirect("/inbox");

  // Only a super admin can create a workspace (completeOnboarding enforces it);
  // anyone else would fill the whole wizard just to be refused at the end.
  const { data: profile } = await supabase
    .from("users")
    .select("is_super_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.is_super_admin !== true) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md space-y-2 text-center">
          <h1 className="font-display text-lg font-semibold text-foreground">
            No tienes acceso a ningún espacio de trabajo
          </h1>
          <p className="text-sm text-muted-foreground">
            Tu acceso fue desactivado o todavía no te han invitado. Pide al
            administrador de la agencia que te agregue a un espacio de trabajo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <OnboardingWizard />
    </div>
  );
}
