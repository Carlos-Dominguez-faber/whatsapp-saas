// Provider-neutral send surface. dispatch.ts (the SEC-04 single exit point)
// asks for a sender for the workspace's active WhatsApp integration and never
// names a provider: YCloud addresses the sender by its E.164 number, Kapso by
// Meta's phone_number_id in the request path.

import * as ycloud from "./ycloud-client";
import * as kapso from "./kapso-client";
import {
  WHATSAPP_PROVIDER_LABELS,
  whatsappApiKey,
  type WhatsAppProvider,
} from "./whatsapp-provider";

/** FLAT parameters per component (both providers take Meta's shape). */
export type TemplateComponents = NonNullable<ycloud.TemplateParams["components"]>;

export interface SendResult {
  /** WhatsApp message id — synchronous on Kapso, may arrive later on YCloud */
  wamid?: string;
  /** The provider's own message id (YCloud only), for status reconciliation */
  providerMessageId?: string;
}

export interface WhatsAppSender {
  provider: WhatsAppProvider;
  label: string;
  /** False for a missing/"placeholder" key: dev mode, nothing is sent. */
  live: boolean;
  sendText(to: string, body: string): Promise<SendResult>;
  sendTemplate(params: {
    to: string;
    templateName: string;
    language?: string;
    components?: TemplateComponents;
  }): Promise<SendResult>;
}

/**
 * Without the id it sends from, the provider API answers with an opaque error
 * (Kapso even gets an empty path segment). Name the missing setting instead:
 * dispatch stores this message on the failed outbound, where the team sees it.
 */
function requireSenderId(value: string, what: string, label: string): string {
  if (!value.trim()) {
    throw new Error(
      `Falta ${what} de ${label}: complétalo en Configuración → Integraciones → WhatsApp`,
    );
  }
  return value;
}

export function whatsappSender(
  provider: WhatsAppProvider,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>,
): WhatsAppSender {
  const apiKey = whatsappApiKey(provider, credentials);
  const live = Boolean(apiKey && apiKey !== "placeholder");
  const label = WHATSAPP_PROVIDER_LABELS[provider];

  if (provider === "kapso") {
    const configured = (config.phone_number_id as string | undefined) ?? "";
    const phoneNumberId = () =>
      requireSenderId(configured, "el Phone Number ID", label);
    return {
      provider,
      label,
      live,
      async sendText(to, body) {
        const sent = await kapso.sendText({
          apiKey,
          phoneNumberId: phoneNumberId(),
          to,
          body,
        });
        return { wamid: sent.wamid || undefined };
      },
      async sendTemplate({ to, templateName, language, components }) {
        const sent = await kapso.sendTemplate({
          apiKey,
          phoneNumberId: phoneNumberId(),
          to,
          templateName,
          language,
          components,
        });
        return { wamid: sent.wamid || undefined };
      },
    };
  }

  const configured = (config.phone_number as string | undefined) ?? "";
  const from = () => requireSenderId(configured, "el número de WhatsApp", label);
  return {
    provider,
    label,
    live,
    async sendText(to, body) {
      const sent = await ycloud.sendText({ apiKey, from: from(), to, body });
      return {
        wamid: sent.wamid || undefined,
        providerMessageId: sent.id || undefined,
      };
    },
    async sendTemplate({ to, templateName, language, components }) {
      const sent = await ycloud.sendTemplate({
        apiKey,
        from: from(),
        to,
        templateName,
        language,
        components,
      });
      return {
        wamid: sent.wamid || undefined,
        providerMessageId: sent.id || undefined,
      };
    },
  };
}
