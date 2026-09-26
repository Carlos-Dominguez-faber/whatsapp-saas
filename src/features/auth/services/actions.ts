"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isSignupOpen, markAsSuperAdmin } from "./signup-gate";

// Map Supabase auth error messages (English) to Spanish for the UI.
// Falls back to the original message when there is no known translation.
function localizeAuthError(msg: string): string {
  const map: Record<string, string> = {
    "Invalid login credentials": "Correo o contraseña incorrectos",
    "Email not confirmed": "Email no confirmado",
    "User already registered": "Este correo ya está registrado",
    "Signups not allowed for this instance":
      "El registro está cerrado. Pide al administrador que te invite.",
  };
  return map[msg] ?? msg;
}

const loginSchema = z.object({
  email: z.string().email("Email inválido"),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
});

const signupSchema = z.object({
  email: z.string().email("Email inválido"),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
});

export async function login(
  _prevState: { error: string } | null,
  formData: FormData,
): Promise<{ error: string }> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return { error: localizeAuthError(error.message) };
  }

  redirect("/inbox");
}

export async function signup(
  _prevState: { error: string } | null,
  formData: FormData,
): Promise<{ error: string }> {
  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  // Invite-only: only the first user (agency super admin) may self-register.
  if (!(await isSignupOpen())) {
    return {
      error:
        "El registro está cerrado. Pide al administrador que te invite a tu cuenta.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return { error: localizeAuthError(error.message) };
  }

  // First registration becomes the agency super admin.
  if (data.user) {
    await markAsSuperAdmin(data.user.id);
  }

  redirect("/login?message=Revisa%20tu%20email");
}

export async function logout(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const emailSchema = z.object({
  email: z.string().email("Email inválido"),
});

export async function requestPasswordReset(
  _prevState: { error?: string; message?: string } | null,
  formData: FormData,
): Promise<{ error?: string; message?: string }> {
  const parsed = emailSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const origin =
    (await headers()).get("origin") ?? process.env.NEXT_PUBLIC_APP_URL ?? "";

  const { error } = await supabase.auth.resetPasswordForEmail(
    parsed.data.email,
    { redirectTo: `${origin}/reset-password` },
  );

  if (error) {
    return { error: localizeAuthError(error.message) };
  }

  // Neutral message — never reveal whether the email exists.
  return {
    message:
      "Si el email existe, te enviamos un enlace para restablecer tu contraseña.",
  };
}

const passwordSchema = z.object({
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
});

export async function updatePassword(
  _prevState: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string }> {
  const parsed = passwordSchema.safeParse({
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    return { error: localizeAuthError(error.message) };
  }

  redirect("/login?message=Contraseña%20actualizada.%20Inicia%20sesión.");
}
