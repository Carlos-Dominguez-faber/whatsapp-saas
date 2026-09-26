# Instalar — Agente WhatsApp (Inbox con IA)

## Para ti (miembro de Imperio Digital)

Arrastraste este archivo al chat de tu agente — **Claude Code** (recomendado),
Codex, o cualquier agente que pueda correr comandos en tu terminal. Solo escribe:

> **instálalo**

Y el agente hace todo: configura tu Supabase, despliega a tu Vercel, crea tu
super admin y deja el cron corriendo. Tarda ~15 minutos.

### Lo que necesitas tener listo (cuentas gratis)

| Cuenta         | Para qué                       | Plan           |
| -------------- | ------------------------------ | -------------- |
| **Supabase**   | Base de datos + Auth + Storage | Free sirve     |
| **Vercel**     | Hospedaje de la app            | Hobby (gratis) |
| **YCloud** o **Kapso** | Número de WhatsApp (proveedor; Kapso si estás en EE. UU.) | Según su plan  |
| **OpenRouter** | El modelo de IA (LLM)          | Pago por uso   |

El agente instala lo demás (Node, los CLIs de Supabase y Vercel). Cuando termine,
te da tu URL de producción: entras con tu super admin al panel de agencia y
creas tu primer workspace de cliente.

> Si todavía no tienes un agente: instala Claude Code (claude.ai/download), ábrelo
> en la carpeta de este proyecto, arrastra este archivo al chat y escribe "instálalo".

---

## Para el agente (Claude Code / Codex) — instrucciones de instalación

Eres el instalador del **Agente WhatsApp**. El usuario opera un negocio, no
necesariamente es técnico. Confirma en **español tuteo** cada paso con un mensaje
corto antes de ejecutarlo.

### Reglas generales

- **NO modifiques el código fuente** (`src/`, `supabase/migrations/`). Solo corres
  los scripts y comandos de abajo.
- **NUNCA pegues secrets en el chat.** Pídele al usuario que los pegue y pásalos
  como variables de entorno **inline** a los scripts (como se muestra). No los
  escribas en archivos a mano: `scripts/setup.mjs` lo hace por ti.
- **NUNCA commitees** `.env.local` ni `*.filled.sql` (ya están en `.gitignore` — no
  los fuerces a git).
- Usa los scripts deterministas para lo mecánico:
  `scripts/setup.mjs` y `scripts/seed-admin.mjs`. Tú te quedas con lo interactivo
  (pedir keys, los `login`, el deploy, confirmar).
- **Si algo falla, detente.** Muestra el error exacto y explícalo en lenguaje simple.
  No sigas al siguiente paso hasta resolverlo.

### Pasos en orden

**1. Localiza el proyecto.** Toma el path del `INSTALAR.md` que te arrastraron y
haz `cd` a su carpeta:

```bash
cd "<carpeta donde está este INSTALAR.md>"
```

Si está en `~/Downloads`, pregúntale al usuario si lo mueves a un lugar fijo
(p.ej. `~/Developer/whatsapp-saas`) antes de seguir.

**2. Prerequisitos.** Verifica las herramientas y dime qué falta:

```bash
node -v   # necesita v20 o superior
node scripts/setup.mjs doctor
```

Si falta el CLI de **Supabase**: `brew install supabase/tap/supabase`
(o ve https://supabase.com/docs/guides/cli).
Si falta el CLI de **Vercel**: `npm i -g vercel`.

**3. Instala dependencias.**

```bash
npm install
```

**4. Supabase: crea el proyecto y pega las 3 keys.** Guía al usuario:

> Entra a https://supabase.com/dashboard → **New project**. Elige una región cercana
> y **guarda la contraseña de la base de datos** (la vas a necesitar en el paso 5).
> Cuando esté listo: **Settings → API**, y copia estos 3 valores.

Pídele las 3 keys de Supabase (y, si ya la tiene, la de OpenRouter) y córrelas
inline. Esto **genera los 3 secrets** y escribe `.env.local`. (El proveedor de
WhatsApp NO va aquí: se configura por workspace en la app, paso 11.)

```bash
NEXT_PUBLIC_SUPABASE_URL='https://xxxx.supabase.co' \
NEXT_PUBLIC_SUPABASE_ANON_KEY='eyJ...' \
SUPABASE_SERVICE_ROLE_KEY='eyJ...' \
OPENROUTER_API_KEY='sk-or-...' \
node scripts/setup.mjs env
```

Si todavía no tiene la de OpenRouter, corre `env` con lo que haya y vuelve a
correrlo después (es idempotente: **no rota** los secrets ya generados).

**5. Aplica las migraciones.** Primero el login (abre el browser, que el usuario
inicie sesión), luego el push (deriva el `project-ref` de la URL):

```bash
supabase login
SUPABASE_DB_PASSWORD='la-contraseña-del-paso-4' node scripts/setup.mjs db-push
```

Esto corre `supabase link` + `supabase db push` (todas las migraciones, incluido el
habilitado de **pg_cron + pg_net** para el cron del buffer).

**6. Despliega a Vercel.** En orden:

```bash
vercel login                              # abre el browser
vercel link                              # crea/enlaza el proyecto (responde los prompts)
node scripts/setup.mjs vercel-env        # sube las env vars a production
vercel --prod                            # primer deploy → copia la URL que imprime
node scripts/setup.mjs set-app-url 'https://TU-URL.vercel.app'
node scripts/setup.mjs vercel-env        # ahora sí sube NEXT_PUBLIC_APP_URL
vercel --prod                            # redeploy con la URL final
```

**7. Site URL en Supabase (automático).** Pídele al usuario un **Management API
token** (https://supabase.com/dashboard/account/tokens → _Generate new token_) y
expórtalo una vez — sirve para los pasos 7 y 9:

```bash
export SUPABASE_ACCESS_TOKEN='sbp_...'
node scripts/setup.mjs site-url
```

Esto setea **Site URL** + **Redirect URLs** a tu dominio de Vercel y **cierra el
registro público** de Supabase Auth. Si el usuario prefiere no usar token, hazlo
manual en Supabase → **Authentication**:

- **URL Configuration** → Site URL = tu URL, Redirect = `<url>/**`.
  (Sin esto, el login y el reset de contraseña redirigen mal.)
- **Sign In / Providers** → desactiva **"Allow new users to sign up"** → Save.
  El formulario `/signup` de la app ya es invite-only, pero la API de Supabase Auth
  (`/auth/v1/signup`) acepta registros con la anon key pública, que viaja en el
  frontend. El super admin (paso 8) y los usuarios que se crean desde el panel
  siguen funcionando, porque usan la Admin API con `service_role`.

**8. Crea tu super admin.** Pídele un email y una contraseña (mínimo 8 caracteres)
para entrar a la plataforma:

```bash
ADMIN_EMAIL='tu@correo.com' ADMIN_PASSWORD='una-clave-segura' \
node scripts/seed-admin.mjs
```

(Crea SOLO el super admin. Los workspaces de clientes se crean desde la app, paso 10.)

**9. Agenda el cron del buffer (automático).**

```bash
node scripts/setup.mjs cron-apply
```

Usa el `SUPABASE_ACCESS_TOKEN` del paso 7 para agendar el cron vía Management API e
imprime la verificación. Si no hay token, cae al camino manual: corre
`node scripts/setup.mjs cron-sql` y pega el SQL en **Supabase → SQL Editor → Run**.

**10. Entra y crea tu primer workspace.** Abre `https://TU-URL.vercel.app/login`,
entra con tu super admin, y en el **panel de agencia** (`/workspaces`) dale **crear
workspace**. La app lo arma completo (prompt, agentes, business info e integración).
Este es el flujo real que repetirás por cada cliente.

**11. Conecta WhatsApp en ESE workspace.** Dentro del workspace, ve a
**Settings → Integraciones → WhatsApp** y elige el proveedor del cliente: **YCloud**,
o **Kapso** si está en Estados Unidos (YCloud no opera ahí).

- **YCloud:** pega la **API Key**, el número (E.164) y el **Webhook Signing Secret**
  (cada cliente tiene los suyos).
- **Kapso:** pega la **API Key** y el **Webhook Signing Secret**, y pulsa **Probar
  conexión**: rellena el `phone_number_id` y el `waba_id` de Meta. Guía detallada:
  `docs/runbook-conectar-numero-kapso.md`.

**Probar conexión** usa lo que está en pantalla, aunque no lo hayas guardado. La app
no activa un proveedor sin API Key, Webhook Signing Secret y número (YCloud) o Phone
Number ID (Kapso): el botón de guardar te dice qué falta.

Guarda, copia el **Webhook URL** que muestra la app (ya trae el `wsid` y la ruta del
proveedor elegido) → pégalo en los webhooks del proveedor y conecta el número.

**12. Verificación final.** Desde un teléfono, manda un WhatsApp al número conectado.
En ~1 minuto (cuando dispare el cron) el agente debe responder. Si no, revisa las
corridas del cron:

```sql
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'buffer-flush')
order by start_time desc limit 5;
```

**13. Más clientes.** Repite los pasos 10–11 por cada cliente nuevo: un workspace +
su propia integración de WhatsApp (cada uno puede usar YCloud o Kapso).

---

## Si algo falla (troubleshooting)

- **`db push` falla al habilitar pg_cron/pg_net:** confirma que el proyecto Supabase
  es válido y que estás usando la contraseña correcta de la base. Ambas extensiones
  están en el allowlist de Supabase (free incluido).
- **El cron corre pero el endpoint responde 401:** el `CRON_SECRET` en Vercel no
  coincide con el del SQL. Re-corre `node scripts/setup.mjs vercel-env`, redeploy, y
  vuelve a correr `cron-sql` + pégalo de nuevo.
- **`vercel-env` dice "already exists":** esa var ya estaba; actualízala en el
  dashboard de Vercel → Settings → Environment Variables.
- **El agente no responde al WhatsApp:** revisa `cron.job_run_details` (paso 12),
  que el webhook del proveedor (YCloud o Kapso) apunte a tu URL con la ruta del
  proveedor activo, y que `OPENROUTER_API_KEY` tenga saldo. Si cambiaste de
  proveedor, el webhook del anterior ya no se acepta (responde 401).
- **Qué pasa con lo que estaba en curso al cambiar de proveedor:**
  - una respuesta que la IA estaba generando sale por el proveedor **nuevo**;
  - si ese envío falla (por ejemplo, una API Key equivocada), la respuesta queda en
    el inbox como mensaje **fallido**, con el error; la conversación no se
    reintenta sola, así que reenvíala desde el inbox;
  - los mensajes que ya había enviado el proveedor anterior se quedan en su último
    estado (por ejemplo "enviado"): sus avisos de entregado/leído llegan a un
    webhook que ya responde 401.

  Por eso conviene probar la conexión antes de guardar, y cambiar en un momento
  de poco tráfico.

## Actualizar a una versión nueva

```bash
git pull                 # o reemplaza los archivos del proyecto
npm install
supabase login           # solo si esta máquina no tiene sesión del CLI
SUPABASE_DB_PASSWORD='tu-contraseña-de-la-base' node scripts/setup.mjs db-push   # SIEMPRE antes del deploy
vercel --prod            # redeploy
```

Corre las migraciones en un momento de poco tráfico: algunas reconstruyen
restricciones de tablas grandes (mensajes) y las bloquean unos segundos.

El orden importa: el código nuevo puede depender de funciones o permisos que traen
las migraciones, así que las migraciones van **antes** de `vercel --prod`.

**Si instalaste desde la antigua rama `provider/kapso`** (Kapso), cámbiate a `main`,
donde ahora viven los dos proveedores. Cada workspace sigue con el proveedor que
tenía **activo**: si tenía Kapso (o Kapso y YCloud a la vez), queda en Kapso; si solo
tenía YCloud activo, queda en YCloud. Después del upgrade, revisa en
**Configuración → Integraciones → WhatsApp** de cada workspace que el proveedor
marcado como "activo" sea el que esperas.

```bash
git fetch origin
git checkout main
git pull
npm install
SUPABASE_DB_PASSWORD='tu-contraseña-de-la-base' node scripts/setup.mjs db-push   # repara el historial de migraciones solo
vercel --prod
```

`db-push` marca como revertidas las dos migraciones que solo existían en esa rama
(`20260731000000/1`; su contenido ya viene en las de `main`) y aplica las nuevas.

**Una sola vez, si tu instalación es anterior al 26-sep-2026** (endurecimiento de
seguridad entre workspaces):

1. Cierra el registro público de Supabase Auth (no toca tu Site URL ni tus Redirect
   URLs). Con el token del paso 7, o sin él para que te diga el paso manual:

   ```bash
   SUPABASE_ACCESS_TOKEN='sbp_...' node scripts/setup.mjs close-signup
   ```

2. Audita lo que pudo pasar mientras los huecos estaban abiertos. En Supabase →
   **SQL Editor**, corre esto y revisa cada resultado:

   ```sql
   -- a) Super admins: deben ser SOLO los que tú creaste. Fíjate en la columna
   --    `cuenta` (el email real de login; `perfil` pudo haberse editado).
   SELECT p.id, a.email AS cuenta, p.email AS perfil, p.created_at
     FROM public.users p JOIN auth.users a ON a.id = p.id
    WHERE p.is_super_admin;

   -- b) Cuentas que se registraron solas (sin perfil): bórralas en
   --    Authentication → Users si no las reconoces.
   SELECT a.id, a.email, a.created_at
     FROM auth.users a LEFT JOIN public.users p ON p.id = a.id
    WHERE p.id IS NULL ORDER BY a.created_at DESC;

   -- c) Admins por workspace, los más recientes primero: busca a alguien que no
   --    diste de alta tú.
   SELECT w.name AS workspace, a.email AS cuenta, m.role, m.is_active, m.created_at
     FROM public.memberships m
     JOIN auth.users a ON a.id = m.user_id
     JOIN public.workspaces w ON w.id = m.workspace_id
    WHERE m.role = 'admin' ORDER BY m.created_at DESC;

   -- d) Perfiles cuyo email no coincide con su cuenta real.
   SELECT p.id, p.email AS perfil, a.email AS cuenta
     FROM public.users p JOIN auth.users a ON a.id = p.id
    WHERE lower(p.email) <> lower(a.email);
   ```

   Si `db-push` avisó `WARNING: ... point at another workspace`, hay filas que
   apuntan a datos de otro workspace. Encuéntralas con:

   ```sql
   SELECT 'messages.conversation_id' AS relacion, x.id FROM public.messages x JOIN public.conversations r ON r.id = x.conversation_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'messages.batch_id', x.id FROM public.messages x JOIN public.message_batches r ON r.id = x.batch_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'messages.template_id', x.id FROM public.messages x JOIN public.templates r ON r.id = x.template_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'message_batches.conversation_id', x.id FROM public.message_batches x JOIN public.conversations r ON r.id = x.conversation_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'events.conversation_id', x.id FROM public.events x JOIN public.conversations r ON r.id = x.conversation_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'conversations.contact_id', x.id FROM public.conversations x JOIN public.contacts r ON r.id = x.contact_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'appointments.contact_id', x.id FROM public.appointments x JOIN public.contacts r ON r.id = x.contact_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'appointments.conversation_id', x.id FROM public.appointments x JOIN public.conversations r ON r.id = x.conversation_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'appointments.schedule_id', x.id FROM public.appointments x JOIN public.schedules r ON r.id = x.schedule_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'kb_chunks.document_id', x.id FROM public.kb_chunks x JOIN public.kb_documents r ON r.id = x.document_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'agents.prompt_id', x.id FROM public.agents x JOIN public.prompts r ON r.id = x.prompt_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'prompts.active_version_id', x.id FROM public.prompts x JOIN public.prompt_versions r ON r.id = x.active_version_id WHERE r.workspace_id <> x.workspace_id
   UNION ALL SELECT 'prompt_versions.prompt_id', x.id FROM public.prompt_versions x JOIN public.prompts r ON r.id = x.prompt_id WHERE r.workspace_id <> x.workspace_id;
   ```

   Bórralas (o corrígelas) y después vuelve a validar las restricciones para
   que cubran también las filas viejas:

   ```sql
   DO $$
   DECLARE r record;
   BEGIN
     FOR r IN SELECT conrelid::regclass AS t, conname FROM pg_constraint
               WHERE conname LIKE 'fk\_%\_same\_workspace' AND NOT convalidated LOOP
       EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.t, r.conname);
     END LOOP;
   END
   $$;
   ```

   Quita el flag con `UPDATE public.users SET is_super_admin = false WHERE id = '...'`,
   desactiva membresías que no reconozcas desde Settings → Equipo y borra las filas
   cruzadas que aparezcan.

**Nunca** rotes `ENCRYPTION_KEY`: es la llave con la que se cifran las
credenciales de integraciones de cada workspace, y cambiarla las vuelve
ilegibles (habría que recapturarlas una por una en Settings → Integraciones).
`setup.mjs env` ya respeta los secrets existentes.

## Desinstalar

Borra el proyecto en Vercel y el proyecto en Supabase. La instalación no escribe
nada fuera de esos dos proyectos en la nube y de esta carpeta.
