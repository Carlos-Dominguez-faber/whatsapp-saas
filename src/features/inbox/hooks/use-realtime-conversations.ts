"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import type { ConversationRow } from "@/features/inbox/types";

/**
 * Keeps the inbox conversation list fresh in real time.
 *
 * The list is server-rendered (page.tsx enriches each conversation with its
 * last message + ordering). Rather than mutating that derived state on the
 * client, we listen for the events that change the list — a new conversation,
 * a state/last_message_at update, or a new message — and ask the server
 * component to re-run via router.refresh(). Refreshes are debounced so a burst
 * of inbound messages collapses into a single re-fetch.
 */
export function useRealtimeConversations(
  workspaceId: string | null,
  onConversationChange?: (
    payload: RealtimePostgresChangesPayload<ConversationRow>,
  ) => void,
): void {
  const router = useRouter();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref para no re-suscribirse cada vez que el caller pasa una función nueva.
  const onConversationChangeRef = useRef(onConversationChange);
  useEffect(() => {
    onConversationChangeRef.current = onConversationChange;
  }, [onConversationChange]);

  useEffect(() => {
    if (!workspaceId) return;

    const supabase = createClient();

    const scheduleRefresh = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        router.refresh();
      }, 400);
    };

    const channel: RealtimeChannel = supabase
      .channel(`inbox:conversations:${workspaceId}`)
      .on<ConversationRow>(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          scheduleRefresh();
          onConversationChangeRef.current?.(payload);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      supabase.removeChannel(channel);
    };
  }, [workspaceId, router]);
}
