# Seguridad

## Versión con soporte

Solo `main`. La rama `provider/kapso` está congelada desde el 26-sep-2026 y no recibe
parches. Si instalaste desde ahí, cámbiate a `main` siguiendo **INSTALAR.md →
Actualizar**: YCloud y Kapso viven juntos en `main` y cada workspace elige su
proveedor.

## Cómo reportar una vulnerabilidad

**No abras un issue ni un PR público.** Repórtala en privado desde GitHub:

https://github.com/Carlos-Dominguez-faber/whatsapp-saas/security/advisories/new

Incluye:

- **dónde está:** la ruta, server action, RPC o migración, y el commit de `main` en que
  lo viste;
- **cómo reproducirlo:** idealmente con dos workspaces de prueba y la api key de
  WhatsApp en `placeholder`, que no manda nada al proveedor. Nunca uses datos de un
  cliente real;
- **el impacto que ves:** por ejemplo, leer o escribir datos de otro workspace,
  subir de rol, mandar mensajes con la cuenta de otro o gastar su IA.

## Qué pasa después

1. Confirmamos que lo recibimos y lo reproducimos.
2. Si se confirma, el arreglo entra a `main` y publicamos un aviso con los pasos para
   actualizar, incluido el orden de siempre: `db-push` antes del deploy.
3. Te damos crédito en el aviso y en el advisory, salvo que prefieras quedar anónimo.

## Alcance

- **Sí entra:** el código de este repo, es decir, la app de Next.js, las migraciones,
  los crons y los scripts de instalación.
- **No entra:**
  - la configuración de tu propia instalación (claves filtradas, un proyecto de
    Supabase o Vercel mal configurado);
  - los servicios de terceros (YCloud, Kapso, OpenRouter, HighLevel, Cal.com,
    HubSpot). Eso repórtalo a cada proveedor.
