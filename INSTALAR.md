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

**9. Agenda los crons (automático).**

```bash
node scripts/setup.mjs cron-apply
```

Agenda tres jobs: `buffer-flush` (responde los mensajes) y `automations` (corre las
automatizaciones), cada minuto, y `classify-topics` (el análisis de temas de
**Análisis**), cada 5 minutos; mientras nadie cree un tema no gasta nada. Usa el `SUPABASE_ACCESS_TOKEN` del paso 7
para agendarlos vía Management API e imprime la verificación. Correrlo otra vez no
duplica nada: actualiza los jobs existentes. Si no hay token, cae al camino manual: corre
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
- **Hay eventos `batch_retry_transient`:** un lote falló por algo que puede ser una
  caída (el modelo, WhatsApp o la base no respondieron) y se va a reintentar a 1, 5
  y 15 minutos. Uno suelto no es problema; muchos seguidos indican una caída en
  curso: revisa el estado de tu proveedor de IA, de WhatsApp y de Supabase.
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
- Las **tools de n8n** (que reemplazan al antiguo "Webhook personalizado", ver
  abajo) siguen hasta 3 redirects, siempre por HTTPS y revisando cada destino. Así
  funcionan, por ejemplo, las web apps de Google Apps Script, que responden a cada
  POST con un redirect después de ejecutarlo. Si el webhook respondió al POST con un
  redirect y un salto posterior falla, la llamada cuenta como entregada: el webhook
  ya la recibió, y el agente no la repite.

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
    mismo número). Un número de HighLevel sin `+` usa el código de país del
    negocio solo si tiene el largo de un número de ese país (10 dígitos en
    México), contando los prefijos de siempre (`044`/`045` o `1` en México, `9` o
    `15` en Argentina, el `0`); o si ya empieza con ese código. Si no, ese
    contacto no se enlaza por teléfono. Si no existe, lo crea.
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
  Solo lo comprueba si el número está guardado con lada internacional (`+52…`,
  `0052…`, o los dígitos empezando con el código de país del negocio): si lo
  escribiste como `998 123 4567` o `1 998 123 4567`, los mensajes se aceptan y un
  evento diario te pide corregirlo. Al guardar, el número se escribe en formato internacional
  (`+52…`) si tu cuenta de YCloud lo confirma o si lo escribiste con lada; si no,
  se guarda como lo escribiste y un aviso te dice cómo corregirlo.
- Las rutas del buffer y los webhooks pueden durar hasta 300 segundos. Vercel lo
  permite en el plan Hobby con **Fluid Compute**, que viene activo en proyectos
  nuevos; en uno viejo, actívalo en Vercel → Settings → Functions.

**Novedades de la Fase 3 (finales de sep-2026):**

- **Agencia → Miembros:** el super admin ve quién tiene acceso a cada workspace y
  puede generar una clave nueva para un miembro activo, que se muestra una sola vez.
  - No resetea la de otro super admin ni la tuya.
  - La clave es de la persona, no del workspace. Si también está activa en otros
    workspaces, la hoja los nombra y pide una segunda confirmación: la clave nueva
    aplica en todos.
  - Al cambiar la clave, Supabase cierra sus sesiones y tokens de refresco. Un
    token de acceso que ya tenía puede seguir funcionando hasta que expire (a lo
    más una hora).
  - Cada reseteo queda en una tabla de auditoría que nadie puede editar ni borrar
    (`member_password_resets`, ni siquiera desde el service role) y como evento en
    cada workspace donde la persona está. Si el registro no se puede escribir, la
    clave no cambia.
  - Al dar de alta un cliente con un email que ya tiene cuenta, la app pide
    confirmar antes de usar esa cuenta (conserva su contraseña).
- **Equipo:** invitar un correo que **ya tiene cuenta** responde "Ese correo ya tiene
  cuenta; pídele a la agencia que lo agregue", salvo que esa persona ya esté en
  este workspace. Solo el super admin agrega cuentas existentes.
- **Citas en HighLevel, beta** (apagadas hasta que las actives en Configuración →
  Tools, donde llevan la etiqueta "Beta"; pruébalas primero en una sub-cuenta de
  HighLevel):
  - `list_highlevel_appointments` (lectura): las próximas citas del contacto, con la
    fecha y hora exactas que el agente debe copiar.
  - `cancel_highlevel` y `reschedule_highlevel`: el agente pasa la fecha y hora de
    la cita que el cliente confirmó, y la tool solo actúa sobre la cita del
    contacto a esa hora. Las fechas van en la zona de agenda (la del negocio, o la
    de la ubicación de HighLevel); una fecha con el offset de otra zona o que no
    existe se rechaza.
  - Si la cita ya estaba cancelada, o ya está en el horario nuevo por un cambio
    anterior, lo dice y no cambia nada: un reintento nunca cancela ni mueve otra
    cita. Tampoco actúa sobre citas pasadas ni cuando hay dos citas a la misma hora.
  - Reagendar conserva la duración de la cita.
  - Si HighLevel no confirma el cambio (error 5xx, tiempo agotado), el agente no le
    dice al cliente que se hizo ni que falló: dice que una persona lo confirmará.
    Cada vez que la consulta o el cambio fallan, queda una **nota interna** en la
    conversación para el equipo.
  - **HighLevel manda:** con un calendario configurado, las citas del contacto se
    leen de HighLevel (su hora, estado y duración), y la tabla local solo guarda una
    copia. Si el equipo mueve o cancela una cita en HighLevel, el agente ve el
    cambio. Sin calendario, la tabla local solo dice qué citas leer.
  - Usan los encabezados `Version` que documenta HighLevel (`2021-04-15` para las
    citas, `2021-07-28` para las citas de un contacto).
  - `schedule_highlevel` agenda siempre al contacto de la conversación; en el chat
    de prueba, ver abajo.
- **Chat de prueba de agentes:**
  - Un **manager** solo corre las tools de **lectura** (consultar disponibilidad,
    una tool de n8n de lectura).
  - Un **admin** corre también las de **escritura** activas: agenda de verdad en
    HighLevel y dispara los workflows de n8n que escriben. Cancelar y reagendar no
    aplican (la prueba no tiene contacto).
  - Para agendar en la prueba, escribe en el chat el teléfono de prueba: solo se
    usa un número que tú escribiste (nunca uno que invente el agente), leído con el
    código de país del workspace, y es ese número el que va a HighLevel. La cita
    aparece en HighLevel como "[Prueba]", y si ese número ya era un contacto, no se
    le cambia el nombre. Antes de tocar HighLevel queda un evento
    `playground_write` con quién la hizo y el teléfono (si no se puede registrar,
    no se agenda), y después se anota cómo terminó.
  - Si la respuesta falla después de ejecutar una acción (o se corta la conexión
    en la prueba de un admin), la pantalla lo dice y el agente recibe una nota
    para no repetirla: revisa qué quedó hecho antes de reintentar.
- **Tools de n8n por workspace** (Configuración → n8n, solo admins): cada fila es una
  tool que llama a un webhook de n8n.
  - El header de autenticación se guarda **cifrado** y nunca se vuelve a mostrar;
    ninguna sesión puede leerlo (ni un admin). No acepta saltos de línea ni
    caracteres de control. Si venías de la rama del PR #11, corre
    `node scripts/encrypt-credentials.mjs` para cifrar los que tengas en texto plano.
  - Cada llamada manda un `idempotency_key`: el mismo para la misma tool con los
    mismos argumentos al contestar el mismo mensaje del cliente, también si ese
    mensaje se reintenta. Úsalo en tu workflow para no escribir dos veces. Ojo: si
    el agente llama la tool **dos veces con los mismos argumentos** en un mismo
    turno, las dos llamadas llevan la misma clave (tu workflow las tratará como
    una).
  - Las llamadas siguen redirecciones (máximo 3, cada salto validado, solo HTTPS,
    sin mandar el header a otro dominio).
  - El agente ve a lo más 16 KB de la respuesta: haz que el workflow devuelva solo
    lo que el agente necesita decirle al cliente.
  - Las llamadas desde el chat de prueba (solo las de un admin corren tools de
    escritura) llevan `playground: true` en el cuerpo, para que tu workflow pueda
    distinguirlas de una conversación real.
  - Una tool nueva es de "escritura" salvo que la marques de lectura (las de
    escritura nunca se reintentan). Un nombre igual al de una tool del sistema se
    rechaza.
- **`custom_webhook` se retiró; las tools de n8n lo reemplazan.** Era una tool
  "sensible" que esperaba una aprobación que ninguna pantalla daba, así que nunca
  corría. Al actualizar, la migración `20260930000007` convierte la configuración de
  cada workspace (si tenía URL) en una tool de n8n **desactivada**, llamada
  `webhook_personalizado` (o `webhook_personalizado_2`, … si el nombre ya estaba en
  uso), con la misma URL, modo asíncrono y de escritura. Después borra
  `custom_webhook` del catálogo y sus configuraciones; el `db push` imprime cuántas
  movió y cuántos headers descartó por inválidos. **Admins: revisen cada tool
  migrada en Configuración → n8n antes de activarla.** Su descripción dice "Migrada desde custom_webhook — revisa antes de
  activar" y lista los campos que enviaba. El workflow ya no recibe
  `{ workspace_id, payload }`, sino `workspace_id`, `conversation_id`, `contact_id`,
  `idempotency_key` y `args.note`, así que hay que ajustarlo. Si la configuración
  traía un header de autenticación, queda en texto plano hasta que corras
  `node scripts/encrypt-credentials.mjs` (ninguna sesión puede leerlo mientras).
- **`handoff_human`** (apagada hasta que la actives en Configuración → Tools): el
  agente puede pasar la conversación a una persona cuando el cliente lo pide o
  cuando no tiene cómo resolver. Primero manda su despedida y luego pasa la
  conversación; si no escribió despedida, o el turno falla después de pedirlo, pasa
  de inmediato y el contacto recibe el aviso de siempre. Si el traspaso falla, se
  reintenta; si vuelve a fallar, queda un evento `handoff_failed`, una nota interna
  y, si el aviso por correo está activo, un correo al equipo.
- **Aviso al equipo por correo** (apagado por defecto: Configuración →
  Integraciones → WhatsApp → "Avisar al equipo por correo…"): cuando una
  conversación pasa a una persona, cada admin, manager y agente activo recibe su
  propio correo (hasta 20, los admins primero), con un tope de 10 avisos por hora
  por workspace. Requiere una cuenta de [Resend](https://resend.com) y dos
  variables en Vercel: `RESEND_API_KEY` y `HANDOFF_NOTIFY_FROM` (una dirección de un
  dominio verificado en Resend). Sin ellas no se manda nada, y la pantalla lo avisa.
- En el inbox, la pestaña muestra cuántas conversaciones esperan a una persona y,
  si das permiso, el navegador avisa una sola vez por cada conversación que entra.
- **Eventos:** las sesiones ya no pueden insertar filas en `events` (solo el
  servidor), así nadie puede falsear un registro ni silenciar un aviso.

**Motor de automatizaciones (Fase 4, principios de oct-2026):**

Las reglas de **Configuración → Automatizaciones** ahora sí se ejecutan solas, y
pueden mandar plantillas de WhatsApp que **Meta cobra** y que llegan a clientes
reales. El orden del upgrade es:

```bash
SUPABASE_DB_PASSWORD='tu-contraseña-de-la-base' node scripts/setup.mjs db-push   # 1. migraciones
vercel --prod                                                                     # 2. deploy
node scripts/setup.mjs cron-apply                                                 # 3. agenda el job 'automations'
```

Sin el paso 3 no corre nada: las reglas se guardan, pero ningún job las ejecuta.

- **Todas las reglas que estaban encendidas se apagan en el upgrade.** Antes nada
  las ejecutaba; encenderlas solas sería mandar mensajes que nadie revisó. La pestaña
  muestra un aviso con cuántas se apagaron, y cada una dice por qué está apagada.
  Revísalas y enciende las que quieras. Editar una regla nunca la enciende: solo el
  interruptor.
- **Disparadores:** primer mensaje, palabra clave, pide humano, lead calificado y
  recordatorio de cita (de 1 a 168 horas antes, solo dentro de la ventana horaria de
  la regla, 8 a 22 por defecto). **Acciones:** mandar plantilla, asignar a un
  agente, etiquetar, cerrar y pasar a humano. Hasta 20 reglas activas por workspace.
- **Nada se manda tarde:** cada evento vence si no se ejecutó a tiempo (palabra
  clave 1 h, pide humano 2 h, primer mensaje y lead calificado 6 h).
- **Cuándo sale un recordatorio:** toca `hours_before` antes de la cita; si esa hora
  cae fuera del horario de envío de la regla (8 a 22 por defecto), toca cuando el
  horario abre. Sale en ese momento. Se omite solo si:
  - faltan menos de 30 minutos para la cita (o ya pasó);
  - le tocaba antes de encender la regla (una regla nueva no manda los recordatorios
    que ya debían haber salido);
  - pasaron más de 30 minutos de horario de envío desde que le tocaba (el cron
    estuvo caído).

  Si al ejecutarse está fuera del horario, espera a que abra (esa espera no cuenta
  como intento fallido). El horario se calcula con la hora local del negocio,
  incluidos los cambios de horario de verano. Aunque haya muchas citas dentro de la
  anticipación de una regla, cada una sale cuando le toca: las que ya se avisaron no
  ocupan el lote de 50 del escaneo. Si una cita se movió después de que su
  recordatorio quedó en cola, ese recordatorio no sale, y por lo general sale el de
  la hora nueva cuando le toque. Hay dos casos en que no: si la cita vuelve a una
  hora que ya tuvo y ya se avisó (A→B→A), y si se adelanta a una hora para la que ya
  no queda la anticipación de la regla (una cita movida a mañana temprano con un
  recordatorio de 24 h).
- **Recordatorios con la hora local del negocio:** la zona sale de la misma
  configuración que la agenda de la Fase 3 (Business info o HighLevel; si no hay
  ninguna, `America/Mexico_City`). Antes de mandarlo, la app confirma la cita en
  HighLevel, antes que cualquier otra revisión: si la cancelaron o la movieron, no
  manda el recordatorio y actualiza la cita local (si esa escritura falla, reintenta).
  Si HighLevel no responde, no encuentra la cita o devuelve un estado desconocido,
  reintenta en vez de mandarlo a ciegas (y no marca la cita como cancelada). Una
  cita de HighLevel en un workspace sin HighLevel conectado no recibe recordatorio
  (motivo `hl_not_connected`).
- **Límites de envío:** una misma regla no le manda plantilla al mismo contacto más
  de una vez cada 24 horas (en los recordatorios, el límite es por cita: dos citas
  del mismo contacto reciben cada una el suyo), y un workspace no manda más de 300
  plantillas automáticas en 24 horas.
- **Qué pasó con cada regla:** la pestaña muestra la última ejecución de cada regla
  (y su motivo si se omitió o falló) y cuántas fallas tuvo en 24 horas. Un aviso
  rojo aparece si se alcanzó el tope diario o si algún envío quedó con resultado
  desconocido. Cuando se agotan los intentos, el motivo dice por qué
  (`max_attempts:<causa>`). Todavía no hay un historial completo de ejecuciones.
- **Sin duplicados:** cada envío se marca antes de salir. Si no se sabe si salió
  (por ejemplo, WhatsApp no contestó a tiempo), el intento queda como fallido con
  "resultado desconocido" en lugar de mandarse otra vez. Solo se reintenta lo que
  WhatsApp rechazó sin enviarlo (límites de envío). Si Meta pausa la plantilla de una
  regla, la regla se apaga y la pestaña lo explica; con YCloud ese aviso llega
  después por el webhook de estados, y ahí también se apaga la regla y la ejecución
  queda como fallida. Si una variable no tiene dato (un contacto sin nombre), no se
  manda con el hueco: la ejecución falla con `missing_variable:<variable>`.
- **Las plantillas se mandan en el idioma elegido en la regla.** Las reglas
  guardadas antes usan el idioma de la plantilla aprobada (o `es`).
- **Bajas (STOP):** si un contacto escribe solo `STOP`, `UNSUBSCRIBE`, `DARME DE BAJA`,
  `NO MÁS MENSAJES` o `NO QUIERO RECIBIR MENSAJES`, o toca el botón de Meta
  "Detener promociones" / "Stop promotions" (sin importar mayúsculas ni acentos),
  queda dado de baja de las **automatizaciones y plantillas**. El agente y el equipo
  **sí** pueden seguir respondiéndole mientras su conversación esté abierta (24 h
  desde su último mensaje); el aviso automático de traspaso de una automatización no
  le llega. Escribir de nuevo **no** lo vuelve a dar de alta; vuelve con `START`,
  `SUSCRIBIRME` o `REANUDAR MENSAJES`. Palabras sueltas como "baja", "alta" o "alto"
  no cuentan (son respuestas normales: "¿planta alta o baja?"), ni una frase que solo
  contiene la palabra ("quiero darme de baja del plan"). La base de datos aplica la
  baja junto con el mensaje, así que no se pierde ni la deshace un reenvío del mismo
  mensaje, y decide por la hora en que el cliente lo mandó: un STOP que llega tarde no
  deshace un START posterior, y un START no quita una baja manual hecha después. Si
  los dos llegan con la misma hora, gana el STOP.
- **La baja es del número:** queda en `contact_opt_outs` por teléfono, así que borrar
  y volver a crear el contacto, o pasarle ese número a otro contacto, no la quita.
  Cuenta como el mismo número con o sin el 1 de los celulares de México (`+52 1 …`) o
  el 9 de Argentina (`+54 9 …`), y un STOP o START aplica a todos los contactos con
  ese número. Solo un admin o manager puede borrar contactos.
- **Reactivar a mano:** en el panel del contacto, solo un **admin o manager** puede
  volver a dar de alta a quien pidió la baja; la base lo exige también. Cada cambio
  manual de opt-in queda como evento `contact_opt_in_changed` con quién lo hizo.
  Guardar el panel sin tocar el interruptor ya no cambia el opt-in, y si el contacto
  escribe STOP mientras guardas, la app pide recargar en vez de borrarlo. Las bajas
  manuales hechas antes de esta versión cuentan como bajas explícitas (el `db push`
  imprime cuántas y deja un evento por cada una).
- **Pie de baja de las plantillas:** usa "Responde STOP para no recibir más
  mensajes" (el generador con IA y la casilla del formulario lo ponen igual). No
  escribas "BAJA": ya no da de baja a nadie.
- **Permisos:** las reglas, los eventos y la cola de ejecuciones solo los escribe el
  servidor; los miembros solo los leen. Una automatización nunca puede apuntar a un
  contacto o conversación de otro workspace.
- **Para apagar todo el motor** sin tocar las reglas, en Supabase → SQL Editor:
  `select cron.unschedule('automations');` (vuelve con `setup.mjs cron-apply`).
- La ruta del cron puede durar hasta 120 segundos (Fluid Compute, igual que el
  buffer).

**Análisis de temas, `/probar` y limpieza (Fase 5, octubre de 2026):**

```bash
SUPABASE_DB_PASSWORD='tu-contraseña-de-la-base' node scripts/setup.mjs db-push   # 1. migraciones
vercel --prod                                                                     # 2. deploy
node scripts/setup.mjs cron-apply                                                 # 3. agenda 'classify-topics'
```

El paso 3 agenda el job nuevo y reagenda los otros dos sin duplicarlos. Sin él, la
pantalla de Análisis funciona pero nunca se analiza nada (avisa que hay
conversaciones sin analizar).

- **Análisis** (`/analisis`, en el menú de arriba): un admin o manager crea hasta 10
  temas (un nombre y qué debe detectar; no puede haber dos activos con el mismo
  nombre, sin contar mayúsculas ni acentos). Cada 5 minutos, el job `classify-topics`
  lee las conversaciones en las que el **cliente** escribió algo nuevo (una hora
  después de su último mensaje; primero lo más antiguo, y los workspaces se turnan:
  primero el que lleva más tiempo sin que se le lea nada; el reprocesamiento de temas
  nuevos lleva su propio turno)
  y marca qué temas plantea. Solo cuenta lo que escribe el cliente: lo que dicen el
  agente o el equipo es contexto, las notas internas nunca se mandan al modelo, y una
  respuesta o un recordatorio no hacen que se vuelva a analizar. El tablero muestra
  hasta ayer: conversaciones, cuántas agendaron y cuántas se derivaron, el ranking de
  temas, la tendencia por semana y el cruce con etiquetas; cada celda abre las
  conversaciones de evidencia. Cualquier miembro lo ve.
- **Solo cuenta lo analizado.** Un tema se mide sobre las conversaciones ya leídas
  ("sobre N de M analizadas"); las que faltan no cuentan ni a favor ni en contra, y el
  tablero dice cuántas faltan y por qué: pendientes (se leen en las próximas horas),
  que fallaron tres veces (se reintentan si el cliente vuelve a escribir) o de más de
  30 días (ya no se leerán).
- **Cada clave de OpenRouter lleva su propia salud**, que se guarda entre corridas
  (la de cada workspace con clave propia, y la de la agencia para todos los demás):
  - si OpenRouter **rechaza la clave** (sin créditos, revocada, limitada, o un 404
    porque su política de datos no deja usar el modelo), queda caída 15 minutos;
  - si **falla tres veces seguidas** (error 5xx, sin red, tiempo agotado, o un
    "200" de OpenRouter que trae el error del proveedor), queda caída 15 minutos, y
    cada caída seguida dura el doble (30 min, 1 h… hasta 6 horas). Una clave que
    usan varios workspaces (la de la agencia, o una propia pegada en dos) solo cae
    si fallan **al menos dos** de ellos: si falla uno solo (por ejemplo, porque sus
    conversaciones rozan el tiempo límite), espera solo ese workspace, con las
    mismas reglas;
  - mientras está caída no se usa, y sus workspaces esperan; al terminar la espera se
    prueba con **una sola** llamada: si responde, vuelve a la normalidad.
  Los demás workspaces siguen a su ritmo: la clave caída de uno nunca detiene a los
  otros. El tablero de los afectados dice que la clave está fallando (la propia), que
  el análisis no está respondiendo (la de la agencia) o que las llamadas de ese
  espacio están fallando. Si cambias la clave, el aviso de la vieja desaparece. Si la caída es la de la
  agencia, el job responde 500 (lo ves en `net._http_response`); las claves propias
  caídas nunca lo hacen. Una clave propia que no se puede descifrar cuenta como caída
  de ese workspace: nunca se le cobra a la de la agencia.
- **Si falla una conversación** con un error pasajero, espera una hora sin gastar
  intento y la corrida sigue con las demás; si la misma conversación vuelve a fallar
  así, espera el doble cada vez (2, 4, 8… hasta 24 horas) y vuelve a una hora en
  cuanto se lee. La corrida solo se detiene si falla nuestra base de datos.
- **Si el modelo rechaza un mensaje** (contenido, moderación, respuesta inválida),
  la conversación espera una hora (dos, la segunda vez) antes del siguiente intento;
  al tercer fallo queda apartada hasta que el cliente vuelva a escribir.
- **Costo:** usa `openai/gpt-4o-mini` por OpenRouter, con la clave del workspace (o
  la de la agencia), y tiene un tope propio de **600,000 tokens por día** (UTC) por
  workspace, hasta unos USD 0.10 a 0.20. **No cuenta en el presupuesto diario del
  agente**: no lo degrada ni lo corta, y el agente tampoco le quita cupo. El día más
  caro de un workspace pasa a ser 1,600,000 tokens (1,000,000 del agente + 600,000
  del análisis). El texto de los clientes va a OpenAI a través de OpenRouter aunque el
  agente use otro modelo (sin nombres ni teléfonos).
- **Hasta dónde mira:** 30 días hacia atrás, los últimos 60 mensajes de cada
  conversación y hasta 800 caracteres por mensaje; si algo quedó fuera, el tablero lo
  dice. Un tema nuevo reprocesa los 30 días anteriores a su creación. Una caída del
  proveedor no hace que se salte ninguna conversación: el reprocesamiento la espera.
  Solo salta una que falla tres veces seguidas (con horas de espera entre una y otra)
  mientras la clave sigue funcionando. Mientras eso no termina, o si el tema se creó
  dentro del período que estás viendo, se mide solo desde la fecha que aparece junto a él, y sin comparación con el período anterior:
  antes de esa fecha no se analizó, y contarlo como 0 % daría números falsos.
- **Capacidad:** cada corrida lee unas 15 a 20 conversaciones (depende de lo que
  tarde el modelo); cada 5 minutos, eso son unas 4,500 al día para toda la
  instalación, repartidas por turnos entre los workspaces. Cada workspace tiene además
  su tope de 600,000 tokens diarios: unas 400 conversaciones al día (a unos 1,500
  tokens cada una). Si un workspace recibe más, lo que no cabe espera al día siguiente (primero lo de las últimas 48 horas, de lo más
  antiguo a lo más nuevo; después lo anterior, de lo más reciente hacia atrás) y el
  tablero muestra cuántas faltan. Para correrlo solo de noche, cambia la línea `'*/5 * * * *'` de
  `supabase/cron/schedule-classify-topics.sql` por `'*/5 4-8 * * *'` y vuelve a correr
  `cron-apply`: gasta algo menos, pero lo de ayer llega incompleto a la mañana y se
  completa la noche siguiente.
- **Para apagarlo:** `select cron.unschedule('classify-topics');` en el SQL Editor.
  Sin temas activos tampoco gasta nada.
- **`/probar`:** una pantalla con solo el chat del agente, para que alguien lo pruebe
  sin el resto de la app (por ejemplo, un cliente antes de salir en vivo): comparte
  `https://TU-URL/probar`. La pestaña **Prueba** de cada agente (en **Configuración →
  Agentes**) también la enlaza.
  - Cualquier miembro del workspace, incluido un viewer, chatea con el agente
    **activo**, con su prompt publicado y su modelo. No se manda nada por WhatsApp.
  - Solo corren las herramientas de consulta (ver disponibilidad, consultas de n8n),
    también para un admin: desde ahí nadie agenda, cancela ni escribe en un CRM.
  - Hasta 20 mensajes por persona y 60 por workspace cada hora, de hasta 1,000
    caracteres, y **100,000 tokens al día** por workspace (UTC). Cada mensaje reserva
    antes lo más que puede gastar (dos pasos del modelo con el prompt completo y 500
    tokens de respuesta); lo reservado de un mensaje en curso cuenta, y al terminar
    se ajusta a lo real. Alcanza para unos 30 mensajes al día con un prompt de
    4 KB, 19 con uno de 10 KB y 11 con uno de 20 KB. También cuentan en el presupuesto diario del workspace: se
    pausan desde los 800,000 tokens, y un mensaje que llevaría al workspace a ese
    umbral se rechaza, para que `/probar` nunca haga que el agente atienda a clientes
    con el modelo barato.
  - Si el agente no responde nada, la pantalla lo dice y el mensaje vuelve a la caja
    de texto.
  - Un mensaje que falla se ajusta a lo que ya gastó: nada si falló antes de llegar
    al modelo (la base de conocimiento caída), o los pasos que el modelo terminó si
    el proveedor contestó con un error (la clave rechazada, un 5xx). Así un paso que
    usó una herramienta sigue contando, y los reintentos durante una caída no se
    comen el tope. Tras un tiempo agotado o un corte de red se queda la reserva
    completa, porque no se sabe qué gastó.
  - Usa una sola herramienta por mensaje.
  - **No aísla datos.** Solo esconde el menú: con la misma cuenta se pueden abrir el
    inbox, el dashboard y los prompts. Si se la das a alguien de fuera, hazlo en un
    workspace de demostración, sin conversaciones reales.
  - Si alguien abre el enlace sin sesión, al entrar vuelve a `/probar`.
- **La clave pública (`anon`) ya no tiene permisos sobre ninguna tabla.** Es la
  clave que viaja en el navegador; hasta ahora solo las políticas de RLS impedían que
  leyera algo. La app no la usa sin sesión. Las tablas que creen las migraciones
  (como `postgres`) tampoco se los dan. Las que crees desde el editor de tablas de
  Supabase Studio sí los reciben (las crea otro rol, `supabase_admin`, cuyos permisos
  por defecto no se pueden cambiar desde aquí): quítaselos con
  `revoke all on public.tu_tabla from anon;`. Si agregaste tablas propias que leías
  sin sesión, tendrás que darle el permiso a mano (`grant select on public.tu_tabla to
  anon;`) y pensar si de verdad quieres eso.
- **Historial de automatizaciones: 30 días.** Un job de pg_cron que agenda el propio
  `db-push` (`automation-history-purge`, cada hora) borra las ejecuciones terminadas
  y los eventos sin ejecución de más de 30 días. Nunca borra una ejecución en cola ni
  un evento que todavía la necesita.
- **Panel de ejecuciones:** en **Configuración → Automatizaciones**, un admin o
  manager ve las ejecuciones recientes: qué regla, a quién, si se ejecutó, se omitió
  o falló, y por qué. Se filtran por resultado.

**Cal.com, HubSpot y el cron del buffer (Fase 5, octubre de 2026):**

Solo `db-push` y deploy; no agrega crons (el `cron-apply` de la sección anterior
sigue haciendo falta si no lo has corrido).

- **Cal.com, beta** (Configuración → Integraciones → Cal.com, solo un admin la
  guarda; las tools vienen apagadas en Configuración → Tools con la etiqueta
  "Beta"; pruébalas primero con una cuenta de Cal.com de prueba):
  - `list_event_types_calcom` y `check_availability_calcom` (lectura): los servicios
    y los horarios libres, en la **zona horaria del negocio** (Configuración →
    Negocio), la misma que usa el agente para hablar de fechas. Cal.com ya no tiene
    su propio campo de zona; al guardar la integración se borra el que hubiera.
  - `schedule_calcom`: agenda con el email del cliente (si no lo tiene, el agente se
    lo pide). Reserva el horario en la base antes de llamar a Cal.com, así que un
    reintento no agenda dos veces.
    - Si la llamada murió antes de mandar nada, el horario se libera a los 2 minutos.
    - Si Cal.com pudo haber agendado (la llamada se cortó a medio envío), el horario
      no se libera solo: cuando el cliente vuelve a pedirlo, la app pregunta a
      Cal.com por su email, servicio y hora; si Cal.com responde que no existe, lo
      libera, y si no da una respuesta completa, pasa la conversación a una persona.
    - Para liberar uno a mano, después de revisar en Cal.com, en Supabase → SQL
      Editor: `update appointments set status = 'cancelled', meta = meta ||
      '{"calcom_claim":"released"}' where id = '<id>' and calcom_booking_uid is
      null;` (o, si la reserva sí existe: `set calcom_booking_uid = '<uid>', meta =
      '{}'`).
  - Los tipos de evento **recurrentes** o **con cupos** (varias personas por
    horario) no se agendan por WhatsApp.
  - Una reserva que el negocio tiene que **confirmar** en Cal.com se le presenta al
    cliente como "solicitada, pendiente de confirmación", y no recibe recordatorio
    mientras siga pendiente.
  - `list_calcom_appointments`, `cancel_calcom` y `reschedule_calcom`: el agente pasa
    la fecha y hora de la cita que el cliente confirmó, copiada de la lista. Cal.com
    manda: la app lee cada cita en Cal.com antes de actuar (y sigue una cita que
    alguien movió allá; la cita movida conserva su recordatorio). Solo ve las citas
    que se agendaron **por WhatsApp**: las que el cliente hizo en la página de
    Cal.com no aparecen.
  - Si Cal.com no responde a tiempo al agendar, cancelar o mover, el agente no le
    dice al cliente ni que sí ni que no: deja una nota interna y pasa la
    conversación a una persona.
  - Los recordatorios del motor de automatizaciones también sirven para citas de
    Cal.com: antes de mandar uno, la app confirma en Cal.com que la cita sigue en
    pie a esa hora.
- **HubSpot, beta** (Configuración → Integraciones → HubSpot, solo un admin):
  alternativa a HighLevel como CRM. **Un solo CRM activo por workspace**: la base no
  deja tener HighLevel y HubSpot encendidos a la vez; para cambiar, desactiva uno.
  - Se conecta con el token de una app privada de HubSpot (permisos de contactos,
    negocios, propiedades de contactos y comunicaciones). **Probar conexión** revisa
    esos permisos, crea en tu HubSpot dos propiedades de contacto, `whatsapp_phone` y
    `whatsapp_tags`, y es obligatorio antes de que sincronice nada. Cambiar el token
    por el de otra cuenta suelta los enlaces de contactos y el pipeline de la
    anterior (hay que elegirlo de nuevo).
  - Sincroniza el contacto (nombre, email y etiquetas; una etiqueta que quitas aquí
    se quita en HubSpot) y, cuando una conversación pasa a una persona o se cierra,
    deja un registro de WhatsApp en la línea de tiempo del contacto, fechado cuando
    pasó (lo manda el cron `automations`, en menos de un minuto; también cuando el
    traspaso lo hizo el sistema porque la IA no pudo responder).
  - Si el token deja de servir (revocado, sin un permiso, sin probar), esos
    registros **esperan**: al volver a **Probar conexión** con la misma cuenta se
    envían. Si HubSpot no confirmó si recibió uno, no se reenvía (para no
    duplicarlo) y queda un evento `crm_sync_failed`.
  - En el modo setter hay una acción nueva, "Crear negocio en HubSpot", en el
    pipeline y etapa que elijas.
  - Los registros ya enviados se borran solos a los 30 días; los que esperan un token
    arreglado, a los 90.
- **HighLevel:** editar un contacto en el panel ahora hace **una sola** subida a
  HighLevel (antes, una por cada etiqueta quitada).
- **Cron `buffer-flush`:** si una de sus dos fases no puede trabajar (la base no
  entrega los lotes o los mensajes sin lote), responde **500** con el código de la
  fase en `net._http_response`, aunque el resto del tick sí haya corrido. Un lote que
  falla sigue siendo un 200.

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

**Si además aplicaste ramas de los PRs #8, #9, #11, #12, #13, #14, #15, #16 o #17 de la
comunidad** (Francisco Velásquez), `db-push` también marca como revertidas sus versiones que
`main` no tiene (la lista está en `scripts/setup.mjs`); si no, `supabase db push` se
niega a seguir. Eso solo destraba el historial: lo que esas migraciones crearon
sigue en tu base. Lo que `main` adoptó de ellas vuelve con versiones nuevas que se
aplican encima (por ejemplo, la tabla `n8n_tools` de #11 se conserva y solo se le
cambian los permisos). El PR #11 también borraba `custom_webhook` del catálogo de
tools (sin migrar sus configuraciones); en `main` lo retira `20260930000007`, que
no hace nada si ya no está. El motor de automatizaciones de #16 vuelve como
`20261001000000`, que se aplica encima de lo que #16 creó: conserva sus eventos y
ejecuciones, apaga las reglas que #16 encendió solo por existir (las que alguien
encendió con su motor siguen encendidas) y cambia sus referencias por unas que no
pueden cruzar workspaces. El análisis de temas de #13 vuelve como `20261002000000..02`,
encima de sus tablas: conserva temas y detecciones, borra las detecciones que #13
guardó sobre mensajes del agente o del equipo (ahora solo cuenta lo que escribe el
cliente) y pasa su gasto de LLM a un presupuesto propio. Cal.com (#15) vuelve como
`20261003000000..03` y HubSpot (#17) como `20261003000004..10`, que se aplican encima
de lo que esos PRs crearon: un enlace de HubSpot que no sea un id numérico se suelta
(el siguiente sync lo vuelve a enlazar) y el `db push` lo avisa con un WARNING.

**Si aplicaste ramas de otros PRs de la comunidad** (fuera de esa lista), traen
versiones que ni `main` ni esa lista conocen, y `supabase db push` se va a negar a
seguir. Es a propósito: nada se aplica a ciegas sobre una base con cambios
desconocidos.

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
