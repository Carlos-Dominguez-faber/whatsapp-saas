import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  getActiveWorkspace,
  ACTIVE_WORKSPACE_COOKIE,
} from "@/features/workspace/services/active-workspace";
import { InboxLayout } from "@/features/inbox/components/inbox-layout";
import type {
  ConversationWithContact,
  ConversationRow,
  ContactRow,
  MessageRow,
} from "@/features/inbox/types";

export default async function InboxPage() {
  const supabase = await createClient();

  // 1. Authenticate
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: userRow } = await supabase
    .from("users")
    .select("is_super_admin")
    .eq("id", user.id)
    .maybeSingle();

  // Agency super admins land in the agency panel by default. They only see a
  // specific inbox after explicitly entering a client (which sets the cookie
  // via "Gestionar" / "Inbox"); otherwise the first-membership fallback would
  // drop them into an arbitrary client's inbox on login.
  const activeCookie = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
  if (userRow?.is_super_admin && !activeCookie) {
    redirect("/workspaces");
  }

  // 2. Resolve active workspace (cookie-selected or first membership)
  const membership = await getActiveWorkspace(supabase, user.id);

  if (!membership) {
    // Super admins without a personal workspace go to the agency panel, not onboarding
    if (userRow?.is_super_admin) {
      redirect("/workspaces");
    }
    redirect("/onboarding");
  }

  // 3. Query conversations with contacts
  const { data: conversations } = await supabase
    .from("conversations")
    .select(
      `
      *,
      contact:contacts(*)
    `,
    )
    .eq("workspace_id", membership.workspace_id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);

  const rows = (conversations ?? []) as (ConversationRow & {
    contact: ContactRow;
  })[];

  // 4. Get last message per conversation
  const convIds = rows.map((c) => c.id);
  let lastMessageMap = new Map<
    string,
    Pick<MessageRow, "body" | "direction" | "created_at">
  >();

  if (convIds.length > 0) {
    // Limitación conocida: esto trae TODOS los mensajes de hasta 50
    // conversaciones para quedarse con el último de cada una. Con poco volumen
    // no molesta, pero PostgREST corta en su tope de filas por defecto: pasado
    // ese tope, las conversaciones que queden afuera
    // muestran preview vacío en la lista, sin error. No se arregla poniéndole
    // un `.limit(N)` acá — eso deja el mismo bug en otra forma. El arreglo es
    // un lateral join o una RPC que devuelva el último mensaje por
    // conversación. Se dejó fuera del fix de los últimos 100 a propósito.
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("conversation_id, body, direction, created_at")
      .in("conversation_id", convIds)
      .order("created_at", { ascending: false });

    if (recentMessages) {
      for (const msg of recentMessages) {
        if (!lastMessageMap.has(msg.conversation_id)) {
          lastMessageMap.set(msg.conversation_id, {
            body: msg.body,
            direction: msg.direction,
            created_at: msg.created_at,
          });
        }
      }
    }
  }

  // 5. Enrich conversations
  const enriched: ConversationWithContact[] = rows.map((conv) => ({
    ...conv,
    last_message: lastMessageMap.get(conv.id) ?? null,
  }));

  return (
    <InboxLayout conversations={enriched} workspaceId={membership.workspace_id}>
      <div className="flex flex-col items-center justify-center h-full text-center px-8">
        <p className="text-sm font-medium text-foreground">
          Selecciona una conversación
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Elige un contacto de la lista para ver el historial
        </p>
      </div>
    </InboxLayout>
  );
}
