import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InboxLayout } from "@/features/inbox/components/inbox-layout";
import { ChatThread } from "@/features/inbox/components/chat-thread";
import type {
  ConversationWithContact,
  ConversationRow,
  ContactRow,
  MessageRow,
} from "@/features/inbox/types";
import type { WorkspaceRole } from "@/features/inbox/hooks/use-role";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function InboxDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  // 1. Authenticate
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // 2. Get active membership → workspace_id + role
  const { data: membership } = await supabase
    .from("memberships")
    .select("workspace_id, role")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .single();

  const role = (membership?.role ?? "agent") as WorkspaceRole;

  // 3. Fetch the conversation + contact
  const { data: convData } = await supabase
    .from("conversations")
    .select("*, contact:contacts(*)")
    .eq("id", id)
    .single();

  if (!convData) notFound();

  const convWithContact = convData as ConversationRow & { contact: ContactRow };

  // 4. Fetch messages: los ÚLTIMOS 100, no los primeros.
  //
  // Iba `ascending: true` + `.limit(100)`, que devuelve los 100 mensajes MÁS
  // VIEJOS: pasada esa marca el hilo quedaba congelado para siempre en el
  // mensaje 100 y el operador no volvía a ver nada nuevo — ni lo que escribía
  // el cliente ni lo que respondía el agente. Se veía como si los mensajes se
  // borraran.
  //
  // Se piden descendentes (los 100 más nuevos) y se invierten acá, porque
  // ChatThread los renderiza en orden cronológico.
  const { data: messagesData } = await supabase
    .from("messages")
    .select("*, sender:users!sender_user_id(full_name, avatar_url)")
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  const messages = ((messagesData ?? []) as MessageRow[]).reverse();

  // 5. Fetch sidebar conversations (same workspace, for InboxLayout)
  let sidebarConversations: ConversationWithContact[] = [];

  if (membership) {
    const { data: conversations } = await supabase
      .from("conversations")
      .select("*, contact:contacts(*)")
      .eq("workspace_id", membership.workspace_id)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(50);

    const rows = (conversations ?? []) as (ConversationRow & {
      contact: ContactRow;
    })[];

    const convIds = rows.map((c) => c.id);
    const lastMessageMap = new Map<
      string,
      Pick<MessageRow, "body" | "direction" | "created_at">
    >();

    if (convIds.length > 0) {
      // Misma limitación conocida que en `inbox/page.tsx`: trae todos
      // los mensajes de hasta 50 conversaciones para quedarse con el último de
      // cada una, y pasado el tope de filas de PostgREST algunas quedan sin
      // preview en silencio. No arreglar con `.limit(N)`; ver el comentario
      // largo en el otro archivo.
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

    sidebarConversations = rows.map((conv) => ({
      ...conv,
      last_message: lastMessageMap.get(conv.id) ?? null,
    }));
  }

  const conversation: ConversationWithContact = {
    ...convWithContact,
    last_message:
      messages.length > 0
        ? {
            body: messages[messages.length - 1].body,
            direction: messages[messages.length - 1].direction,
            created_at: messages[messages.length - 1].created_at,
          }
        : null,
  };

  return (
    <InboxLayout
      conversations={sidebarConversations}
      workspaceId={membership?.workspace_id ?? null}
    >
      <ChatThread
        conversation={conversation}
        initialMessages={messages}
        currentUserId={user.id}
        role={role}
      />
    </InboxLayout>
  );
}
