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
| WhatsApp  | Kapso (ver abajo)                            |
| Hosting   | Vercel                                       |

## Elegir proveedor de WhatsApp

**Estás en `provider/kapso`.** El proveedor no es intercambiable por
configuración: su API define la forma de los envíos, el payload de los webhooks y
el esquema de firma. Por eso vive en una rama, no en una variable de entorno.

| Rama             | Proveedor        | Cuándo usarla                                           |
| ---------------- | ---------------- | ------------------------------------------------------- |
| `main`           | **YCloud**       | Por defecto                                             |
| `provider/kapso` | **Kapso** ← esta | **Obligatoria en Estados Unidos** — YCloud no opera ahí |

```bash
git clone -b provider/kapso https://github.com/Carlos-Dominguez-faber/whatsapp-saas.git
```

### Qué trae esta rama que `main` no

|                      | YCloud (`main`)                             | Kapso (esta rama)               |
| -------------------- | ------------------------------------------- | ------------------------------- |
| Disponible en EE.UU. | ❌                                          | ✅                              |
| Identidad del emisor | `phone_number` (E.164)                      | `phone_number_id` de Meta       |
| Firma del webhook    | con timestamp, ventana anti-replay de 300 s | HMAC-SHA256 sin timestamp       |
| Nombre del evento    | en el body                                  | en el header `X-Webhook-Event`  |
| Coexistence          | no soportado                                | soportado                       |
| Prueba de conexión   | `GET /balance`                              | listado de números del proyecto |

Kapso pide **dos IDs de Meta** que YCloud no necesita —`phone_number_id` y
`waba_id`— y ambos se autocompletan al pulsar «Probar conexión» en
Settings → Integraciones. Esta rama añade además dos migraciones propias.

**Coexistence:** si el mismo número se usa también desde la app de WhatsApp
Business en un celular, Kapso reenvía esas respuestas humanas
(`whatsapp.message.sent` con `origin: business_app`). El sistema las guarda y pasa
la conversación a `human_active` para que el agente no conteste encima de la
persona.

Para conectar un número, ver
[`docs/runbook-conectar-numero-kapso.md`](docs/runbook-conectar-numero-kapso.md).

> Las mejoras que no son del proveedor (inbox, KB, agente) se hacen en `main` y
> se traen aquí con `git merge main`.

## Desarrollo local

```bash
npm install
cp .env.local.example .env.local   # llena tus keys (o usa: node scripts/setup.mjs env)
npm run dev                        # http://localhost:3000
```

Otros comandos: `npm run build`, `npm run lint`, `npm run typecheck`.

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
└── seed-admin.mjs  # Super admin + workspace demo
```

## Variables de entorno

Ver [`.env.local.example`](.env.local.example). Las de Supabase y OpenRouter las
pegas tú; `ENCRYPTION_KEY`, `BUFFER_PROCESS_SECRET` y `CRON_SECRET` las **genera**
`scripts/setup.mjs`. **Kapso y HighLevel NO son env vars** — se configuran por
workspace en Settings → Integraciones.

### Credenciales de integraciones

Lo que guardas en Settings → Integraciones (API key de Kapso, signing secret,
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

_Material para miembros de Imperio Agentico._
