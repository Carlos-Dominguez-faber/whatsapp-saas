# Runbook — conectar un número de producción de Kapso

Estado al 2026-08-01: `main` en `3d7dbb6`, producción desplegada en
`https://lula-morales-whatsapp.vercel.app`. La integración del workspace apunta
hoy al **sandbox**; estos pasos la mueven al número de producción de Juan.

## Datos del número (verificados por API)

| Campo | Valor |
| --- | --- |
| Número | `+1 956-951-2241` |
| Nombre verificado | `GetAIMatrix` |
| `phone_number_id` | `1203313306190056` |
| `waba_id` | `2773824486318506` |
| Modo | coexistence (`is_coexistence: true`) |

Si algún día no los tienes a mano, salen de una sola llamada — **no** hace falta
el dashboard, pese a lo que decía el plan de migración:

```bash
curl -sS "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers" \
  -H "X-API-Key: $KAPSO_API_KEY"
```

---

## 1. Apuntar el workspace al número de producción

En la app: **Settings → Integraciones → Kapso (WhatsApp)**.

| Campo | Qué poner |
| --- | --- |
| API Key | la del proyecto de Kapso (ya guardada) |
| Número de WhatsApp (E.164) | `+19569512241` |
| **Phone Number ID (Meta)** | `1203313306190056` |
| **WABA ID** | `2773824486318506` |
| Webhook Signing Secret | **el mismo que ya está guardado** — no lo cambies aquí sin cambiarlo también en Kapso |

Pulsa **Probar conexión**. Debe responder `Kapso conectado — +1 956-951-2241`.

Si dice *"El Phone Number ID configurado no existe en este proyecto"*, rellena los
IDs con lo que te ofrezca el propio test y guarda. Ese mensaje es la red que
atrapa el error más caro de esta migración: un `phone_number_id` mal puesto hace
que **todo** envío falle con 400.

> El campo "Número de WhatsApp" es solo para mostrar en la UI y el CRM. Lo que
> realmente envía es el **Phone Number ID**. No son lo mismo.

## 2. Crear el webhook en Kapso

Copia el **Webhook URL** que muestra la pantalla de Integraciones (ya trae el
`?wsid=` correcto). Debe ser:

```
https://lula-morales-whatsapp.vercel.app/api/webhooks/kapso?wsid=b1bbdbca-5160-4905-891a-07e953d52185
```

Por dashboard: **WhatsApp → Configurations → el número → Manage Webhooks**.
Por API, que queda reproducible:

```bash
curl -X POST \
  "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/1203313306190056/webhooks" \
  -H "X-API-Key: $KAPSO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "whatsapp_webhook": {
      "url": "https://lula-morales-whatsapp.vercel.app/api/webhooks/kapso?wsid=b1bbdbca-5160-4905-891a-07e953d52185",
      "secret_key": "<EL MISMO SIGNING SECRET DE LA APP>",
      "events": [
        "whatsapp.message.received",
        "whatsapp.message.sent",
        "whatsapp.message.delivered",
        "whatsapp.message.read",
        "whatsapp.message.failed"
      ],
      "active": true
    }
  }'
```

Los cinco eventos son necesarios: `received` trae los mensajes, los otros cuatro
mueven el estado y — en coexistence — `sent` es además por donde llega el eco
del humano.

### Verifica que el buffering quedó apagado

La respuesta debe traer `"buffer_enabled": false`. Compruébalo:

```bash
curl -sS "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/1203313306190056/webhooks" \
  -H "X-API-Key: $KAPSO_API_KEY" | grep -o '"buffer_enabled":[a-z]*'
```

Si alguna vez sale `true`, apágalo. Con el buffering encendido Kapso agrupa los
mensajes en un sobre `{batch:true, data:[…]}` que este webhook no procesa. La app
ya tiene su propio buffer (`buffer_silence_seconds`); dos sobran. El síntoma sería
silencio total sin errores, y en los logs de Vercel:
`[kapso] webhook batching is ON`.

## 3. Probar

**3.1 Ciclo normal.** Manda un WhatsApp a `+1 956-951-2241` desde otro teléfono.
En ~15-30 s el agente debe contestar. En el inbox debes ver el entrante y la
respuesta pasando de `sent` a `delivered` a `read`.

**3.2 El eco de coexistence — esto es lo que nunca se ha probado.** Con la
conversación abierta, responde **desde la app de WhatsApp Business en el celular
del número**, no desde el inbox. Debe ocurrir todo esto:

- El mensaje del humano aparece en el inbox como saliente.
- La conversación pasa a **`human_active`** y el agente **deja de responder**.
- En `events` queda un `state_change` con `trigger: "business_app"`.

Si el agente sigue contestando encima del humano, el eco no se está procesando:
revisa que `whatsapp.message.sent` esté entre los eventos del webhook.

Para reactivar el agente, vuelve la conversación a `ai_active` desde el inbox.

**3.3 Plantillas** (opcional, requiere WABA de producción):
Settings → Plantillas → sincronizar.

## 4. Qué mirar si algo falla

**Lo primero, siempre**: qué intentó entregar Kapso.

```bash
curl -sS "https://api.kapso.ai/platform/v1/webhook_deliveries?per_page=10" \
  -H "X-API-Key: $KAPSO_API_KEY"
```

Ojo: el endpoint lleva **guion bajo** (`webhook_deliveries`). Con guion medio da 404.

| Lo que ves | Qué significa |
| --- | --- |
| No hay entregas | Kapso no está disparando: revisa que el webhook exista y esté `active` |
| `http=401` | La firma no cuadra: el `secret_key` de Kapso ≠ el de la app |
| `http=200` pero nada en el inbox | El evento se recibió y se descartó. Mira los logs de Vercel |
| `http=5xx` | Error de la app: logs de Vercel |

Un 401 también sale si el `phone_number_id` del evento no coincide con el
configurado en el workspace — es una defensa a propósito, y significa que el
`?wsid=` del webhook apunta a otro workspace.

Cuidado con la trampa de los 200: Kapso puede reportar `delivered` mientras
nosotros descartamos el evento en silencio. **Un 200 no prueba que el mensaje se
haya guardado** — confírmalo siempre en el inbox o en la base.

## 5. Limpieza de la prueba de sandbox

Cuando el número de producción esté funcionando:

```bash
# borrar el webhook de sandbox que apuntaba al preview
curl -X DELETE "https://api.kapso.ai/platform/v1/whatsapp/webhooks/9213bbe2-8f07-4415-ba3e-90b087fa250f" \
  -H "X-API-Key: $KAPSO_API_KEY"
```

Y en Vercel: **Settings → Deployment Protection → Protection Bypass for
Automation → revocar**. Ese secreto permitía saltarse la protección de los
previews; ya no hace falta.

---

## Pendientes conocidos

- **`contact.name` llega vacío.** En el sandbox el payload no traía
  `conversation.kapso.contact_name`. Verifica si producción sí lo manda; si
  tampoco, hay que decidir de dónde sale el nombre del contacto.
- **Las plantillas nunca se han probado contra Kapso** — solo se validó que el
  listado responde (vacío).
- **Sin ventana anti-replay.** Kapso firma sin timestamp. Los mensajes entrantes
  están cubiertos por el índice único de `messages.wamid`; los status updates no.
  Cerrarlo del todo requiere persistir `X-Idempotency-Key`.
