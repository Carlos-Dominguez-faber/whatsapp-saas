# Agente WhatsApp — Inbox Conversacional con IA

Plataforma **multi-tenant** de inbox de WhatsApp con un agente de IA operable por
humano: inbox tipo WhatsApp Web, CRM, motor de agente con handoff, agendamiento y
cumplimiento de la ventana de 24h de Meta. Cada workspace es un cliente.

## Instalar (one-click con tu agente)

Clona el repo, ábrelo en Claude Code y deja que el agente lo instale:

```bash
git clone https://github.com/Carlos-Dominguez-faber/whatsapp-saas.git
cd whatsapp-saas
claude "lee INSTALAR.md e instálalo"
```

(O arrastra **[`INSTALAR.md`](INSTALAR.md)** al chat de Claude Code y escribe
**"instálalo"**.)

El agente configura tu Supabase, despliega a tu Vercel, crea tu super admin y deja
el cron corriendo en ~15 minutos. Solo te pedirá tus keys y los logins de
Supabase/Vercel.

> Los comandos del instalador (`npm`, `supabase`, `vercel`, los scripts de
> `scripts/`) ya vienen **pre-aprobados** en
> [`.claude/settings.json`](.claude/settings.json), así que la instalación fluye sin
> clics de permiso. Los únicos pasos que pueden pedirte confirmación son los que
> cargan tus secrets (keys / contraseñas) — apruébalos con confianza.

> Sin git: usa **"Use this template"** en GitHub, o descarga el ZIP del repo.

## Qué incluye

- **Inbox** tipo WhatsApp Web con buffer inteligente (agrupa mensajes y responde
  como un solo turno coherente).
- **Motor de agente** con state machine + handoff humano, prompting personalizable
  y tools activables (incluye modo setter y agendamiento).
- **CRM** con sincronización opcional a HighLevel (por workspace).
- **Knowledge Base** con búsqueda semántica (pgvector).
- **Templates** y manejo de la ventana de 24h de Meta.
- **Multi-tenant** con roles, RLS por workspace y super admin.

## Stack

| Capa      | Tecnología                                   |
| --------- | -------------------------------------------- |
| Framework | Next.js 16 + React 19 + TypeScript           |
| Estilos   | Tailwind CSS + shadcn/ui                     |
| Backend   | Supabase (Auth + PostgreSQL + RLS + Storage) |
| IA        | OpenRouter (LLM gateway)                     |
| WhatsApp  | YCloud o Kapso, por workspace (ver abajo)    |
| Hosting   | Vercel                                       |

## Elegir proveedor de WhatsApp

Cada **workspace** elige su proveedor en **Settings → Integraciones → WhatsApp**:
**YCloud** o **Kapso**. Los dos viven en `main` y en la misma instalación. Una
agencia puede tener clientes de Estados Unidos en Kapso y de Latinoamérica en
YCloud.

| | YCloud | Kapso |
| --- | --- | --- |
| Disponible en EE. UU. | ❌ | ✅ |
| Identidad del emisor | `phone_number` (E.164) | `phone_number_id` de Meta |
| Plantillas | WABA resuelto desde el número | `waba_id` configurado (se autocompleta) |
| Firma del webhook | con timestamp, ventana anti-replay de 300 s | HMAC-SHA256 sin timestamp |
| Coexistence (responder desde la app en el celular) | no soportado | soportado |
| Prueba de conexión | `GET /balance` | listado de números del proyecto |
| Webhook | `/api/webhooks/ycloud?wsid=…` | `/api/webhooks/kapso?wsid=…` |

Solo puede haber **un proveedor activo por workspace**. Al cambiarlo, el anterior
queda guardado, desactivado, por si vuelves. Los ajustes del workspace (buffer,
memoria, aviso de handoff, Jev) se trasladan solos, y los webhooks del proveedor
anterior dejan de aceptarse.

Con Kapso, `phone_number_id` y `waba_id` se autocompletan al pulsar «Probar
conexión». Con **coexistence**, si el mismo número se usa también desde la app
de WhatsApp Business en un celular, esas respuestas humanas se guardan y la
conversación pasa a `human_active` para que el agente no conteste encima de la
persona. Guía paso a paso: [`docs/runbook-conectar-numero-kapso.md`](docs/runbook-conectar-numero-kapso.md).

> La antigua rama `provider/kapso` quedó congelada: todo vive en `main`. Si
> instalaste desde esa rama, cambia a `main` como indica INSTALAR.md →
> "Actualizar".

## Desarrollo local

```bash
npm install
cp .env.local.example .env.local   # llena tus keys (o usa: node scripts/setup.mjs env)
npm run dev                        # http://localhost:3000
```

Otros comandos: `npm run build`, `npm run lint`, `npm run typecheck`.

Pruebas:

- `npm run test:unit` — pruebas unitarias con `node --test` (Node ≥ 22.18).
- `supabase test db` — pruebas de seguridad de la base (pgTAP, en
  `supabase/tests/`) contra un Supabase local (`supabase start`).

## El cron del buffer

El inbox agrupa los mensajes entrantes en _batches_ que un worker debe drenar
~cada minuto. Como Vercel Cron solo corre por-minuto en el plan Pro, esta
distribución agenda el flush dentro de Postgres con **pg_cron + pg_net**, que
llaman a `/api/cron/buffer-flush` (autenticado con `CRON_SECRET`). Lo configura el
instalador — ver [`supabase/cron/schedule-buffer-flush.sql`](supabase/cron/schedule-buffer-flush.sql).

## Estructura

```
src/
├── app/        # Next.js App Router ((auth), (main), api/)
├── features/   # Feature-First (inbox, settings, crm, tools, kb, …)
└── shared/     # Reutilizable (components, lib, types)
supabase/
├── migrations/ # Schema (RLS, super admin, pg_cron, …)
└── cron/       # SQL post-deploy del buffer-flush
scripts/
├── setup.mjs       # Orquestador de instalación (secrets, env, db, cron)
└── seed-admin.mjs  # Crea el super admin
```

## Variables de entorno

Ver [`.env.local.example`](.env.local.example). Las de Supabase y OpenRouter las
pegas tú; `ENCRYPTION_KEY`, `BUFFER_PROCESS_SECRET` y `CRON_SECRET` las **genera**
`scripts/setup.mjs`. **YCloud, Kapso y HighLevel NO son env vars** — se configuran
por workspace en Settings → Integraciones.

### Credenciales de integraciones

Lo que guardas en Settings → Integraciones (API key de YCloud o Kapso, signing secret,
PIT de HighLevel) se cifra con **AES-256-GCM** antes de tocar la base. La llave
es `ENCRYPTION_KEY` y vive solo en el entorno del servidor: quien tenga acceso
de lectura a Postgres ve ciphertext, no las keys.

Cada valor queda ligado a su `workspace_id` + proveedor, así que un blob copiado
de un tenant a otro no descifra.

> **Si instalaste antes de esta versión**, tus credenciales están en texto plano.
> La app las sigue leyendo, pero para cifrarlas corre:
>
> ```bash
> node scripts/encrypt-credentials.mjs --dry-run   # ver qué cambiaría
> node scripts/encrypt-credentials.mjs             # aplicar
> ```

---

## Licencia

[MIT](LICENSE). Puedes usar, modificar, forkear, redistribuir, vender y cobrar
por este software, incluso con fines comerciales y sin pagar regalías. La única
condición es conservar el aviso de copyright y el texto de la licencia en las
copias o partes sustanciales que distribuyas. Se entrega **sin garantía**.

_Nacido como material para miembros de Imperio Agentico — el código es MIT para
cualquiera._
