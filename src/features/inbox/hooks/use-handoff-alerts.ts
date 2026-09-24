"use client";

import { useCallback, useEffect, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { isHandoffTransition } from "./handoff-alert";
import type { ConversationRow, ConversationWithContact } from "@/features/inbox/types";

type NotificationSupport = "unsupported" | NotificationPermission;

// Título base de la pestaña, capturado UNA sola vez por documento (no por
// instancia del hook). Re-leer document.title en cada montaje obligaría a
// sanearlo con una regex, que se comería prefijos "(N)" legítimos ("(2026)
// Inbox" quedaría en "Inbox"). Con la variable de módulo, la primera lectura
// (antes de que cualquier instancia haya puesto un contador) queda fija para
// toda la vida de la página, y una instancia que monta antes de que la
// anterior desmonte reusa ese mismo valor en vez de leer el título con el
// contador ya puesto.
let cachedBaseTitle: string | undefined;

/** Solo para tests: el módulo vive mientras dure la página real. */
export function __resetBaseTitleForTests(): void {
  cachedBaseTitle = undefined;
}

export function getBaseTitle(): string {
  if (cachedBaseTitle === undefined) {
    cachedBaseTitle = typeof document !== "undefined" ? document.title : "";
  }
  return cachedBaseTitle;
}

/**
 * Avisa al operador que SÍ tiene el inbox abierto de que entró una
 * conversación en `handoff_pending`, sin que tenga que mirar la pantalla:
 * contador en el título de la pestaña (siempre) + notificación nativa del
 * navegador (si dio permiso). Degrada en silencio sin la Notification API o
 * sin permiso — el contador sigue funcionando igual.
 */
export function useHandoffAlerts(conversations: ConversationWithContact[]) {
  // Solo cuenta las conversaciones YA CARGADAS en el listado
  // (paginado a 50 en el inbox), así que puede quedar en 0 habiendo
  // handoff_pending más antiguos fuera de esa página. El mecanismo
  // principal es la notificación nativa del navegador (abajo), que no
  // depende de este listado — subir esto a una cuenta server-side si el
  // contador del título necesita ser exacto.
  const pendingCount = conversations.filter(
    (c) => c.state === "handoff_pending",
  ).length;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const original = getBaseTitle();
    document.title = pendingCount > 0 ? `(${pendingCount}) ${original}` : original;
  }, [pendingCount]);

  // Restaura el título al desmontar (deps vacíos → el cleanup solo corre acá).
  useEffect(() => {
    return () => {
      if (typeof document === "undefined") return;
      document.title = getBaseTitle();
    };
  }, []);

  const [permission, setPermission] = useState<NotificationSupport>(() =>
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported",
  );

  // Pedir permiso solo desde un control explícito (botón), nunca al cargar.
  const requestPermission = useCallback(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    Notification.requestPermission().then(setPermission);
  }, []);

  const handleConversationChange = useCallback(
    (payload: RealtimePostgresChangesPayload<ConversationRow>) => {
      if (typeof window === "undefined" || !("Notification" in window)) return;
      if (Notification.permission !== "granted") return;
      if (!isHandoffTransition(payload)) return;

      const conversationId = payload.new.id;
      const notification = new Notification("Un cliente pide hablar con una persona", {
        body: "Hay una conversación esperando en el inbox.",
        tag: `handoff-${conversationId}`,
      });
      notification.onclick = () => {
        window.focus();
        window.location.href = `/inbox/${conversationId}`;
        notification.close();
      };
    },
    [],
  );

  return { pendingCount, permission, requestPermission, handleConversationChange };
}
