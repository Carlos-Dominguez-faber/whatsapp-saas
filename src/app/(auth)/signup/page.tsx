import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignupForm } from "@/features/auth/components/signup-form";
import { isSignupOpen } from "@/features/auth/services/signup-gate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Crear cuenta — Agente WhatsApp",
};

export default async function SignupPage() {
  // Invite-only after bootstrap: once the admin account exists, no public signup.
  if (!(await isSignupOpen())) {
    redirect(
      "/login?message=El%20registro%20es%20solo%20por%20invitaci%C3%B3n",
    );
  }

  return <SignupForm />;
}
