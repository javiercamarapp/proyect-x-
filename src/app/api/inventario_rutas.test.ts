import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// CADA RUTA NUEVA (bajo `src/app`, no solo `src/app/api`) PASA POR UNA
// REVISIÓN CONSCIENTE (auditoría 21; ampliada a toda la app en la 28, SEG-B1).
//
// El matcher de `proxy.ts` EXCLUYE todo `/api` a propósito (decisión de
// diseño documentada en su cabecera: webhook, demo, export manejan lo suyo y
// no deben pasar por el gate ni cargar cabeceras de página). Eso significa
// que cada `route.ts` bajo `src/app/api/` es su PROPIA y ÚNICA puerta:
// sesión + rol + tenant los resuelve el archivo mismo, sin red de respaldo
// del lado del proxy — a diferencia de /dashboard y /admin, que tienen la
// puerta de proxy.ts MÁS la de la página.
//
// La auditoría 28 (SEG-B1) encontró que este inventario escaneaba SOLO
// `src/app/api`, dejando fuera cinco `route.ts` que viven en otras ramas de
// `src/app` y que `proxy.ts` tampoco cubre (su `RUTAS_CON_SESION` solo nombra
// /dashboard, /admin, /vendedor): `auth/callback`, las tres variantes de
// `.well-known/oauth-*` y `pago/[token]/complemento/[uuid]`. Ninguna es un
// hallazgo nuevo — las cinco YA tienen su propia puerta (ver el detalle de
// cada una abajo) — pero el inventario que promete "cada ruta nueva pasa por
// revisión consciente" no era verdad fuera de /api. Ahora escanea `src/app`
// entero: cualquier `route.ts` nuevo, esté donde esté, sube esta constante.
//
// Esta prueba NO agrega una segunda capa de gate (revertir la exclusión del
// proxy sobre las rutas de /api es otro trabajo, con otro riesgo). Es el
// MECANISMO DE CONTENCIÓN: inventaría el disco —no una lista que alguien
// mantenga— y compara contra la constante de abajo. Crecer la superficie sin
// tocar este archivo pone la suite en rojo; tocar este archivo es el momento
// de la revisión. El mismo trato que ya reciben los previews
// (sin_previews.test.ts).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El número de archivos `route.ts` bajo `src/app/` (toda la app, no solo
 * `src/app/api/`) que YA fueron revisados.
 *
 * 64 (auditoría 21, 29-ago-2026) → 65 (auditoría 24, 1-sep-2026:
 * `v1/operadores/route.ts`) → 66 (auditoría 24, BLOQ-6: `v1/liquidaciones/
 * route.ts`) → 67 (auditoría 25: `client-error/route.ts`) → 72 (auditoría 28,
 * 7-sep-2026, SEG-B1: el escaneo pasa de `src/app/api` a `src/app` entero y
 * aparecen cinco rutas que ya existían y ya tenían puerta propia, solo que
 * nadie las había hecho pasar por ESTE inventario:
 *
 *   · `auth/callback/route.ts` — SIN sesión a propósito: es el destino del
 *     intercambio de código de Supabase (`exchangeCodeForSession`) que CREA
 *     la sesión; exigir sesión aquí sería pedirle al login el resultado que
 *     todavía no tiene. Su puerta es el `code` de un solo uso que emite
 *     Supabase (o, sin `code`, cae a un mensaje de error de login sin tocar
 *     nada de negocio) y una allowlist de PREFIJOS DE RUTA PROPIOS para el
 *     `next` de retorno (nunca una URL completa: así se cierra el open
 *     redirect).
 *   · `.well-known/oauth-authorization-server/route.ts`,
 *     `.well-known/oauth-protected-resource/route.ts` y
 *     `.well-known/oauth-protected-resource/api/mcp/route.ts` — SIN sesión a
 *     propósito: son metadatos de descubrimiento OAuth (RFC 8414 y RFC 9728)
 *     que el propio estándar exige servir en público, sin autenticar, para
 *     que un cliente MCP pueda encontrar dónde autorizar. No filtran dato de
 *     negocio ni de tenant: solo URLs y capacidades del servidor.
 *   · `pago/[token]/complemento/[uuid]/route.ts` — autenticado por el token
 *     de un solo uso en el PATH (`resolverLiga(token)`, resuelto de nuevo
 *     contra la base en esta llamada, sin confiar en que "venía de la
 *     página"), con rate limit por IP (30/10min) y el `uuid` del complemento
 *     filtrado siempre por el `factura_id`/`tenant_id` de la liga resuelta:
 *     un folio de otra flota o inventado no encuentra nada.
 *
 * Si vas a subir este número: primero confirma que la ruta nueva trae su
 * propia puerta COMPLETA — sesión (o firma de webhook / llave de API / token
 * de un solo uso / secreto de cron), rol y tenant, o una razón documentada
 * para no tenerlos (como las cuatro públicas de arriba) — ANTES de procesar
 * nada. Ni el proxy ni este inventario la van a salvar.
 */
// 1-sep-2026 (auditoría 24, BLOQ-6): +1 por `v1/liquidaciones/route.ts`.
// Su puerta: `abrir(req, 'dinero')` —llave API por área o cookie+CSRF— antes
// de tocar la base, y `.eq('tenant_id', acceso.tenantId)` en la única consulta.
// 3-sep-2026 (auditoría 25, ALTO): +1 por `client-error/route.ts`. SIN
// sesión a propósito, mismo criterio que `health/route.ts` y `lead/route.ts`:
// es el destino de un fallo de CLIENTE (el layout raíz truena antes de que
// la sesión se pueda leer), así que exigir sesión sería pedirle al reporte
// del fallo la misma cosa que acaba de fallar. Su puerta es otra: rate limit
// por IP (`client-error:${clientIp}`, 20/min), tope de cuerpo (4 KB) aplicado
// durante la lectura streaming (`leerTextoAcotado`), `level` acotado a {warn,error} y
// `msg`/`meta` saneados (sin saltos de línea, `meta` solo si es objeto plano)
// ANTES de tocar `logger.error`/Sentry — no filtra dato de negocio ni tenant.
// 7-sep-2026 (auditoría 28, SEG-B1): 67 → 72. El escaneo deja de limitarse a
// `src/app/api` y cubre `src/app` entero (ver el comentario de arriba con el
// detalle de las cinco rutas que aparecen).
const RUTAS_APP_REVISADAS = 72;

function rutasApp(): string[] {
  const raiz = join(process.cwd(), 'src', 'app');
  return readdirSync(raiz, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === 'route.ts')
    .map((e) => relative(raiz, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

describe('la superficie de rutas de src/app no crece en silencio', () => {
  it(`hay exactamente ${RUTAS_APP_REVISADAS} route.ts bajo src/app`, () => {
    const rutas = rutasApp();

    const mensaje = rutas.length > RUTAS_APP_REVISADAS
      ? 'Una ruta nueva apareció bajo src/app sin que nadie confirme que tiene su ' +
        'propia puerta (sesión+rol+tenant, o una razón documentada para no tenerla) ' +
        '— revísala y sube esta constante (RUTAS_APP_REVISADAS en este archivo). ' +
        'Recuerda: proxy.ts excluye /api entero y su RUTAS_CON_SESION solo nombra ' +
        '/dashboard, /admin y /vendedor, así que fuera de esas tres la puerta que esa ' +
        'ruta escriba adentro es la ÚNICA que tiene.\n\nInventario actual ' +
        `(${rutas.length}):\n  ` + rutas.join('\n  ')
      : 'Desaparecieron rutas bajo src/app (¿se borró o movió un endpoint?). Si fue a ' +
        'propósito, baja RUTAS_APP_REVISADAS en este archivo para que el inventario ' +
        `siga siendo verdad.\n\nInventario actual (${rutas.length}):\n  ` + rutas.join('\n  ');

    expect(rutas.length, mensaje).toBe(RUTAS_APP_REVISADAS);
  });
});
