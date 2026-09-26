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
  conexión**: rellena el `phone_number_id` y el `waba_id` de Meta. El
  `phone_number_id` **no es el número de teléfono**: si los confundes, todos los
  envíos fallan con 400.

**Probar conexión** usa lo que está en pantalla, aunque no lo hayas guardado. La app
no activa un proveedor sin API Key, Webhook Signing Secret y número (YCloud) o Phone
Number ID (Kapso): el botón de guardar te dice qué falta.

Guarda, copia el **Webhook URL** que muestra la app (ya trae el `wsid` y la ruta del
proveedor elegido) → pégalo en los webhooks del proveedor y conecta el número.

En **Kapso**, al crear el webhook con el mismo signing secret, suscribe los cinco
eventos: `whatsapp.message.received` (trae los mensajes) y `sent`, `delivered`,
`read` y `failed` (mueven el estado; con coexistence, `sent` es además por donde
llega la respuesta del humano desde el celular).

> ⚠️ **El buffering de webhooks de Kapso debe quedar APAGADO** (`buffer_enabled:
> false`). Si se activa, Kapso agrupa los mensajes en un sobre `{batch:true,
> data:[…]}` que este webhook no procesa, y el agente se queda callado sin dar
> error. La app ya tiene su propio buffer (`buffer_silence_seconds`); dos sobran.
> Si queda encendido lo verás en los logs de Vercel como
> `[kapso] webhook batching is ON`.

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
- **Kapso: no llegan los mensajes.** Lo primero es ver qué intentó entregar Kapso
  (el endpoint lleva guion bajo; con guion medio da 404):

  ```bash
  curl -sS "https://api.kapso.ai/platform/v1/webhook_deliveries?per_page=10" \
    -H "X-API-Key: $KAPSO_API_KEY"
  ```

  - **sin entregas:** el webhook no existe o no está `active` en Kapso;
  - **`401`:** el signing secret de Kapso no es el de la app, o el
    `phone_number_id` del evento no es el del workspace (el `?wsid=` de la URL
    apunta a otro workspace);
  - **`200` pero nada en el inbox:** el evento llegó y se descartó; revisa los logs
    de Vercel (por ejemplo, el buffering de Kapso encendido). Un 200 no prueba que
    el mensaje se guardó;
  - **`5xx`:** error de la app; revisa los logs de Vercel.
- **Qué pasa con lo que estaba en curso al cambiar de proveedor:**
  - una respuesta que la IA estaba generando sale por el proveedor **nuevo**;
  - si ese envío falla (por ejemplo, una API Key equivocada), la respuesta queda en
    el inbox como mensaje **fallido**, con el motivo; solo se reintenta sola cuando
    WhatsApp la rechazó por límite de envío, así que en los demás casos reenvíala
    desde el inbox;
  - los mensajes que ya había enviado el proveedor anterior se quedan en su último
    estado (por ejemplo "enviado"): sus avisos de entregado/leído llegan a un
    webhook que ya responde 401.

  Por eso conviene probar la conexión antes de guardar, y cambiar en un momento
  de poco tráfico.
- **En los logs de Vercel sale `[db] reserve_llm_turn is missing`,
  `[db] sum_daily_llm_tokens is missing` o `[db] reserve_workspace_llm_call is
  missing`:** desplegaste antes de `db-push`. El agente sigue respondiendo y los
  topes siguen aplicando con lecturas directas (menos exactas ante mensajes
  simultáneos) hasta que corras `setup.mjs db-push`.
- **En los logs de Vercel sale `[db] upsert_batch_and_link_message is missing`:**
  desplegaste antes de `db-push`. Los mensajes se siguen agrupando con el método
  anterior (dos escrituras, sin la garantía de no perder uno) hasta que corras
  `setup.mjs db-push`.
- **Un mensaje saliente quedó en rojo:** toca el ícono: dice por qué falló (número
  sin WhatsApp, ventana de 24 horas vencida, plantilla pausada…). El detalle
  técnico queda en la tabla `message_errors`, que solo se lee desde el servidor
  (Supabase → Table Editor).
- **La conversación pasó a "en espera de un asesor" sin que nadie lo pidiera:**
  puede ser el juez Jev, el tope diario de IA con el traspaso activado, o que la IA
  ya había ejecutado una acción (por ejemplo, agendó) y no pudo terminar su
  respuesta: una persona confirma, en vez de repetir la acción. En los dos últimos
  casos queda una nota interna en la conversación que lo explica.
- **Hay eventos `batch_dead_letter`:** el lote falló y agotó sus 3 reintentos; el
  `error` del evento dice por qué. La conversación pasa a una persona (con el
  aviso al contacto y la notificación al equipo, si los tienes activos) y queda una
  nota interna en ella; para que la IA vuelva a contestar, reactívala en la
  conversación. Si fue al revisar el presupuesto (`reserve_llm_turn failed` /
  `sum_daily_llm_tokens failed`), la base no respondió en ese momento: revisa el
  estado de tu proyecto de Supabase.
- **Hay eventos `handoff_failed`:** la conversación tenía que pasar a una persona
  pero el cambio falló, así que la IA sigue activa. Queda una nota interna en la
  conversación; revísala tú.
- **Hay eventos `inbound_destination_mismatch`:** llegó al webhook de YCloud de
  este workspace un mensaje para otro número, y se ignoró. Si es tu número, revisa
  el que tienes en Configuración → Integraciones → YCloud.
- **Hay eventos `inbound_destination_unchecked`:** el número de YCloud está guardado
  sin lada internacional, así que no se puede comprobar que cada mensaje que llega
  sea para él (se aceptan todos). Escríbelo como `+52 998 123 4567` y guarda.
- **Sincronizar o enviar plantillas dice "No encontramos el número de WhatsApp de
  este espacio":** el número guardado en Integraciones → YCloud no está entre los de
  tu cuenta de YCloud. Corrígelo y vuelve a intentar.
- **Un mensaje saliente dice "WhatsApp no aceptó este envío por ahora":** WhatsApp
  limitó los envíos; la IA lo vuelve a intentar en unos minutos (el reintento aparece
  como otro mensaje).
- **Una nota interna dice "No se envió esta respuesta":** la IA respondió, pero la
  ventana de 24 horas ya había vencido o el contacto pidió no recibir mensajes. La
  nota trae el texto por si quieres retomarlo con una plantilla.
- **Un mensaje dice "No se pudo confirmar el envío":** hubo un error de red o del
  proveedor después de mandarlo, y es posible que sí haya llegado. Revisa con el
  contacto antes de reenviarlo.
- **Al agregar una URL a la base de conocimiento:** solo se leen páginas públicas.
  Se siguen hasta 3 redirects y cada destino se revisa igual que la URL original.
  - **"URL no permitida":** la URL o un redirect apunta a una IP privada o interna.
  - **"No se encontró el dominio de la URL (o solo tiene IPv6, que no se admite)":**
    el dominio no existe, o solo tiene direcciones IPv6.
  - **"La página redirige demasiadas veces":** más de 3 redirects.

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

**Cambios de permisos y límites (versión de finales de sep-2026):**

- En **Configuración → Integraciones** (WhatsApp, OpenRouter y HighLevel) solo un
  **admin** del workspace guarda cambios; un manager las ve y puede probar la
  conexión. Los ajustes del juez Jev (pestaña Agentes) y activar o configurar
  tools siguen abiertos a managers.
- Probar HighLevel y cargar sus pipelines pide rol **manager** o superior.
- Agentes y viewers ya no ven la configuración de tools ni de integraciones, ni el
  costo LLM del dashboard, ni el panel de observabilidad del inbox; el catálogo de
  tools se les muestra en solo lectura.
- Generar una plantilla con IA pide rol **manager** o superior.
- Por workspace y por hora: hasta **20** plantillas generadas con IA y **60**
  mensajes en la prueba de agentes. Sus tokens cuentan en el presupuesto diario.
- Los modelos de agentes y de OpenRouter se eligen solo del catálogo.
  - Si el workspace usa la clave de OpenRouter de la agencia (no tiene una
    propia), un modelo fuera del catálogo — guardado antes o por otro camino — se
    reemplaza en cada llamada por el modelo por defecto de la plataforma
    (`OPENROUTER_DEFAULT_MODEL`), y queda un evento `model_outside_catalog` al día.
  - Con clave propia, el workspace puede usar cualquier modelo: lo paga él.
  - La prueba de agentes pide cambiar un modelo de agente que ya no está en el
    catálogo.
- El presupuesto diario sigue en **1,000,000 tokens** por workspace (se reinicia a
  las 00:00 UTC):
  - desde **800,000** el agente responde con un modelo más barato (con el prompt
    completo), y se pausan las plantillas con IA y la prueba de agentes; queda un
    evento `cost_alert` al día;
  - al llegar a **1,000,000** el agente deja de responder con IA hasta el día
    siguiente (el juez Jev, que corre fuera de este presupuesto, sigue pudiendo
    pasar la conversación a una persona); queda un evento `cost_cut` al día.
- Si al revisar el presupuesto la base no responde, el lote se reintenta (y tras 3
  reintentos queda como `batch_dead_letter` en `events`) en vez de perderse sin
  aviso. El reintento no gasta otro turno del tope por hora.
- El tool **Webhook personalizado** sigue hasta 3 redirects, siempre por HTTPS y
  revisando cada destino. Así funcionan, por ejemplo, las web apps de Google Apps
  Script, que responden a cada POST con un redirect después de ejecutarlo. Si el
  webhook respondió al POST con un redirect y un salto posterior falla, la llamada
  cuenta como entregada: el webhook ya la recibió, y el agente no la repite.

**Cambios en el buffer y los envíos (Fase 2, finales de sep-2026):**

- Un mensaje fallido muestra el motivo en español al tocar su ícono rojo. Las
  plantillas de autenticación (códigos de verificación) ya no se envían a
  revisión: WhatsApp solo las acepta desde su biblioteca oficial.
- Los mensajes enviados por **YCloud** ahora avanzan a entregado y leído (antes
  se quedaban en "enviado").
- Las respuestas con botones o listas, los formularios (Flows), los pedidos del
  catálogo y las ubicaciones le llegan al agente como texto, no como "[Multimedia]".
  Las reacciones se guardan en la conversación, pero no gastan un turno de la IA.
- El buffer procesa **un lote por conversación a la vez, el más viejo primero**, y
  los mensajes que llegan mientras tanto se juntan en uno solo (una respuesta, no
  una por mensaje). La respuesta de la IA se guarda antes de enviarse: si el envío
  falla y se reintenta, se reenvía el mismo texto sin volver a llamar al modelo ni
  a sus tools. Solo se reintenta cuando no salió (límite de envío de WhatsApp);
  si pudo haber salido, queda como fallida en vez de arriesgar un duplicado.
- Si la IA ya ejecutó una acción (agendar, escribir en el CRM) y no pudo terminar
  su respuesta, la conversación pasa a una persona: nunca se repite la acción.
- Si una persona toma la conversación mientras la IA está respondiendo, esa
  respuesta ya no se envía.
- Un lote que falla por algo que puede ser una caída (el modelo, WhatsApp o la base
  no responden) se reintenta a 1, 5 y 15 minutos, así que una caída de unos minutos
  no pasa a una persona cada conversación activa. Un lote atorado (la función murió
  a medio turno) se retoma a los 7 minutos. Si se agotan los 3 reintentos, la
  conversación pasa a una persona igual que con una palabra clave (con el aviso al
  contacto y la notificación al equipo), queda una nota interna y un
  `batch_dead_letter` en `events`. Si la respuesta ya había salido, el lote solo se
  cierra.
- Un mensaje que llegó pero no quedó en ningún lote (falló la base justo al
  guardarlo) se recupera en la siguiente pasada del cron, siempre que tenga entre
  2 y 15 minutos, la IA siga encendida en esa conversación y el contacto no haya
  llegado a su tope por hora. Pasados 15 minutos ya no se contesta solo.
- **Nuevo ajuste, apagado por defecto:** Configuración → Integraciones → WhatsApp →
  "Pasar a una persona si se acaba el presupuesto diario de IA".
- El webhook de contactos de **HighLevel** ahora sí sincroniza (antes fallaba
  siempre sin avisar). **Es la primera vez que corre**: si tu HighLevel manda
  webhooks de contactos, cada alta o cambio allá llega ahora a tu base, y cada uno
  hace una lectura a la API de HighLevel (cuenta para sus límites de uso). Si no
  quieres esa sincronización, quita el webhook de contactos en HighLevel.
  - Enlaza el contacto de HighLevel con el de WhatsApp que tenga el mismo
    teléfono, aunque esté escrito distinto (`+52 1…` y `+52…` cuentan como el
    mismo número). Un número de HighLevel sin código de país usa el del negocio
    solo si tiene el largo de un número de ese país (10 dígitos en México); si
    no, ese contacto no se enlaza por teléfono. Si no existe, lo crea.
  - No sobrescribe nada tuyo: **suma** sus etiquetas a las locales y solo llena
    el nombre y el correo si estaban vacíos.
  - Al revés, al guardar un contacto aquí sus etiquetas se **agregan** en
    HighLevel, nunca reemplazan las de allá (las de tus flujos de HighLevel se
    quedan). Por eso quitar una etiqueta aquí no la quita en HighLevel, y la
    siguiente sincronización desde HighLevel puede volver a traerla: quítala en
    los dos lados.
  - Si dos contactos tuyos resultan ser la misma persona en HighLevel, no se
    fusionan ni se le pasa nada al duplicado: queda un evento
    `hl_contact_link_conflict` (uno al día por contacto) que dice cuál tiene el
    enlace, y el botón de sincronizar del contacto lo avisa en vez de decir que
    salió bien.
  - Si al actualizar dos contactos de un workspace ya compartían el mismo id de
    HighLevel, `db-push` deja el enlace solo en el que se tocó más recientemente
    y lo avisa con un `WARNING` que lista cuáles se desenlazaron.
- Los horarios de HighLevel se consultan en la zona horaria del negocio
  (Configuración → Negocio) si el agente no pide otra.
- La sincronización de plantillas de **YCloud** ahora sí trae tus plantillas (antes
  traía cero), y solo las de la cuenta de WhatsApp (WABA) del número del workspace,
  hasta 1,000. Si ese número no está en tu cuenta de YCloud, sincronizar y enviar
  plantillas avisan en vez de usar el WABA de otro número. Después de actualizar,
  sincroniza en Configuración → Templates y revisa que aparezcan.
- Si la zona horaria del negocio no es válida (por ejemplo `-05:00` o `EST`), se usa
  `America/Mexico_City`. Guárdala como zona IANA, por ejemplo `America/Bogota`.
- El webhook de **YCloud** configurado con `?wsid=` ignora los mensajes dirigidos a
  otro número que no sea el del workspace, y lo deja en `events` una vez al día.
  Solo lo comprueba si el número está guardado con lada internacional: si lo
  escribiste como `998 123 4567`, los mensajes se aceptan y un evento diario te
  pide corregirlo. Al guardar, el número se escribe en formato internacional
  (`+52…`) si tu cuenta de YCloud lo confirma o si lo escribiste con lada; si no,
  se guarda como lo escribiste y un aviso te dice cómo corregirlo.
- Las rutas del buffer y los webhooks pueden durar hasta 300 segundos. Vercel lo
  permite en el plan Hobby con **Fluid Compute**, que viene activo en proyectos
  nuevos; en uno viejo, actívalo en Vercel → Settings → Functions.

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

**Si además aplicaste ramas de los PRs #8 o #9 de la comunidad** (Francisco
Velásquez), `db-push` también marca como revertidas sus versiones que `main` no
tiene (la lista está en `scripts/setup.mjs`); si no, `supabase db push` se niega a
seguir. Eso solo destraba el historial: lo que esas migraciones crearon sigue en
tu base. Lo que `main` adoptó de ellas vuelve con versiones nuevas que se pueden
aplicar encima.

**Si aplicaste ramas de otros PRs de la comunidad (#10–#17)**, traen versiones que
ni `main` ni esa lista conocen, y `supabase db push` se va a negar a seguir. Es a
propósito: nada se aplica a ciegas sobre una base con cambios desconocidos.

1. Corre `supabase migration list` y anota las versiones que solo aparecen del lado
   remoto (tu base).
2. Revisa qué creó cada una (su archivo en la rama del PR).
3. Si aceptas conservar esos cambios en tu base, márcalas:
   `supabase migration repair --status reverted <versiones>`. Luego vuelve a correr
   `setup.mjs db-push`.

Si no estás seguro de qué hicieron, pide ayuda antes de repararlas: son cambios de
esquema que `main` no conoce.

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
